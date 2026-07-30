/**
 * Application wiring.
 *
 * This module owns no rules. It creates a `GameController`, listens to what it
 * reports, and keeps the DOM, the announcer and the sound engine in step. Every
 * board interaction is forwarded straight to the controller, which is the only
 * thing allowed to change a game state.
 */

import { DIFFICULTIES, type Difficulty } from './ai/types.ts';
import { getAllBoards, getBoard, resolveBoardId } from './data/boards.ts';
import {
  DEFAULT_STATS,
  loadSettings,
  loadStats,
  resetStats,
  saveSettings,
  trackEvent,
  type Settings,
} from './data/settings.ts';
import {
  Announcer,
  describeCell,
  describeMove,
  describeResult,
  describeSkip,
  describeTurn,
  type DescribeContext,
} from './accessibility/announcements.ts';
import { installKeyboardControls } from './accessibility/keyboard-controls.ts';
import { GameController, type ControllerEvent, type MatchSummary } from './game/game-controller.ts';
import { countEmpty } from './game/scoring.ts';
import type { GameState, Move, PlayerId } from './game/types.ts';
import { registerServiceWorker } from './pwa/register-sw.ts';
import { MotionController, pulse } from './ui/animation-controller.ts';
import { BoardRenderer } from './ui/board-renderer.ts';
import { createBoardThumbnail } from './ui/board-thumb.ts';
import { installBoardInput } from './ui/input-controller.ts';
import { createCrest, createMonsterBadge, TEAM_NAMES } from './ui/monsters.ts';
import { bindSegmented, bindSwitch, Dialog, ScreenManager } from './ui/screens.ts';
import { MusicController, type MusicScene } from './ui/music-controller.ts';
import { renderSky } from './ui/sky.ts';
import { SoundController } from './ui/sound-controller.ts';
import { Tutorial } from './ui/tutorial.ts';

/* ------------------------------------------------------------------ helpers */

function need<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as unknown as T;
}

/**
 * With animations switched off there is nothing to wait for, so the opponent
 * answers as fast as it can think rather than sitting on a cosmetic delay.
 */
function pacingForMotion(motionEnabled: boolean) {
  return motionEnabled
    ? { moveSettleMs: 300, minThinkingMs: 260 }
    : { moveSettleMs: 40, minThinkingMs: 0 };
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------- setup */

const app = need<HTMLElement>('app');
const settings: Settings = loadSettings();

/**
 * Deep-link overrides: `?board=islands&mode=local-two-player&start=1`.
 *
 * These make a specific match shareable and give the end-to-end suite a way to
 * reach a known position without clicking through the menu. They are applied in
 * memory only — a link never rewrites the player's saved preferences.
 */
const params = new URLSearchParams(location.search);

function applyUrlOverrides(): void {
  const board = params.get('board');
  if (board) settings.boardId = resolveBoardId(board);

  const mode = params.get('mode');
  if (mode === 'local-two-player' || mode === 'vs-computer') settings.mode = mode;

  const difficulty = params.get('difficulty');
  if (difficulty && (DIFFICULTIES as readonly string[]).includes(difficulty)) {
    settings.difficulty = difficulty as Difficulty;
  }

  const motionParam = params.get('motion');
  if (motionParam === 'reduced' || motionParam === 'full' || motionParam === 'auto') {
    settings.motion = motionParam;
  }

  const soundParam = params.get('sound');
  if (soundParam === 'on' || soundParam === 'off') settings.soundEnabled = soundParam === 'on';

  const musicParam = params.get('music');
  if (musicParam === 'on' || musicParam === 'off') settings.musicEnabled = musicParam === 'on';
}

applyUrlOverrides();

/** Fixed AI seed for reproducible matches; otherwise the clock. */
const matchSeed = Number.parseInt(params.get('seed') ?? '', 10);

const motion = new MotionController(app);
motion.setPreference(settings.motion);
app.setAttribute('data-contrast', settings.contrast);

const announcer = new Announcer();
const sound = new SoundController({ enabled: settings.soundEnabled, volume: settings.volume });
// Music shares the effects' audio graph so the two pass through one compressor
// and a loud cue can never be buried under the bed.
const music = new MusicController(() => sound.bus(), {
  enabled: settings.musicEnabled,
  volume: settings.musicVolume,
});
const screens = new ScreenManager();

const pauseDialog = new Dialog(need<HTMLElement>('overlay-pause'), need<HTMLElement>('pause-dialog'));
const confirmDialog = new Dialog(need<HTMLElement>('overlay-confirm'), need<HTMLElement>('confirm-dialog'));
const resultDialog = new Dialog(need<HTMLElement>('overlay-result'), need<HTMLElement>('result-dialog'));

let controller: GameController | null = null;
let renderer: BoardRenderer | null = null;
let detachBoard: Array<() => void> = [];
let lastSummary: MatchSummary | null = null;
let previousScores = { player1: 0, player2: 0 };
let peekTimer: ReturnType<typeof setTimeout> | null = null;

/* --------------------------------------------------------------- menu chrome */

need<HTMLElement>('menu-crest').replaceChildren(createCrest());
renderSky(need<HTMLElement>('menu-motes'), { enabled: motion.enabled });

for (const player of [1, 2] as const) {
  const holder = document.querySelector<HTMLElement>(`[data-monster="${player}"]`);
  holder?.replaceChildren(createMonsterBadge(player, 30));
  const chip = need<HTMLElement>(`score-p${player}`);
  const name = chip.querySelector('[data-name]');
  if (name) name.textContent = TEAM_NAMES[player];
}

const boardPicker = need<HTMLElement>('board-picker');
const boardHint = need<HTMLElement>('board-hint');

function buildBoardPicker(): void {
  boardPicker.replaceChildren();
  for (const board of getAllBoards()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'boardcard';
    card.setAttribute('role', 'radio');
    card.dataset.value = board.id;
    card.setAttribute('aria-checked', String(board.id === settings.boardId));
    card.setAttribute('tabindex', board.id === settings.boardId ? '0' : '-1');

    const thumb = document.createElement('span');
    thumb.className = 'boardcard__thumb';
    thumb.appendChild(createBoardThumbnail(board));
    card.appendChild(thumb);

    const label = document.createElement('span');
    label.textContent = board.name;
    card.appendChild(label);

    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = `. ${board.description} ${board.playableCount} playable spaces.`;
    card.appendChild(sr);

    boardPicker.appendChild(card);
  }
}

buildBoardPicker();

const setBoardValue = bindSegmented(boardPicker, (value) => {
  settings.boardId = resolveBoardId(value);
  saveSettings(settings);
  updateBoardHint();
  sound.play('ui-tap');
});

function updateBoardHint(): void {
  const board = getBoard(settings.boardId);
  boardHint.textContent = `${board.strategy} ${board.playableCount} playable spaces.`;
}

const setModeValue = bindSegmented(need<HTMLElement>('option-mode'), (value) => {
  settings.mode = value === 'local-two-player' ? 'local-two-player' : 'vs-computer';
  saveSettings(settings);
  syncModeVisibility();
  sound.play('ui-tap');
});

const setDifficultyValue = bindSegmented(need<HTMLElement>('option-difficulty'), (value) => {
  settings.difficulty = (DIFFICULTIES as readonly string[]).includes(value)
    ? (value as Difficulty)
    : 'normal';
  saveSettings(settings);
  sound.play('ui-tap');
});

function syncModeVisibility(): void {
  need<HTMLElement>('option-difficulty').hidden = settings.mode !== 'vs-computer';
}

setBoardValue(settings.boardId);
setModeValue(settings.mode);
setDifficultyValue(settings.difficulty);
syncModeVisibility();
updateBoardHint();

function updateMenuStats(): void {
  const stats = loadStats();
  const node = need<HTMLElement>('menu-stats');
  if (stats.matchesCompleted === 0) {
    node.textContent = 'No matches yet — your first one takes about three minutes.';
    return;
  }
  node.textContent = `${stats.matchesCompleted} matches · ${stats.playerWins} wins · ${stats.computerWins} losses · ${stats.ties} ties`;
}

updateMenuStats();

/* ------------------------------------------------------------ sound toggles */

const soundButtons = [need<HTMLElement>('btn-sound-menu'), need<HTMLElement>('btn-sound-game')];
const musicButtons = [need<HTMLElement>('btn-music-menu')];

function syncSoundUi(): void {
  for (const button of soundButtons) {
    button.setAttribute('aria-pressed', String(settings.soundEnabled));
    const icon = button.querySelector('[data-sound-icon]');
    const label = button.querySelector('[data-sound-label]');
    if (icon) icon.textContent = settings.soundEnabled ? '\u{1F50A}' : '\u{1F507}';
    if (label) label.textContent = settings.soundEnabled ? 'Sound on' : 'Sound off';
  }
  setSoundSwitch(settings.soundEnabled);
}

function setSoundEnabled(enabled: boolean): void {
  settings.soundEnabled = enabled;
  saveSettings(settings);
  sound.setEnabled(enabled);
  if (enabled) void sound.unlock().then(() => sound.play('ui-tap'));
  syncSoundUi();
}

for (const button of soundButtons) {
  button.addEventListener('click', () => setSoundEnabled(!settings.soundEnabled));
}

function syncMusicUi(): void {
  for (const button of musicButtons) {
    button.setAttribute('aria-pressed', String(settings.musicEnabled));
    const icon = button.querySelector('[data-music-icon]');
    const label = button.querySelector('[data-music-label]');
    // A crossed-out note reads as "off" without relying on the pressed state.
    if (icon) icon.textContent = settings.musicEnabled ? '\u{266B}' : '\u{266A}';
    if (label) label.textContent = settings.musicEnabled ? 'Music on' : 'Music off';
  }
  setMusicSwitch(settings.musicEnabled);
}

function setMusicEnabled(enabled: boolean): void {
  settings.musicEnabled = enabled;
  saveSettings(settings);
  music.setEnabled(enabled);
  if (enabled) void sound.unlock().then(() => music.play(currentMusicScene()));
  else music.stop();
  syncMusicUi();
}

for (const button of musicButtons) {
  button.addEventListener('click', () => setMusicEnabled(!settings.musicEnabled));
}

/** Which bed suits what is on screen right now. */
function currentMusicScene(): MusicScene {
  if (screens.current === 'game' && controller?.state.status === 'finished') {
    if (settings.mode === 'local-two-player' || lastSummary?.winner === controller.humanPlayer) {
      return 'victory';
    }
    return lastSummary?.winner === 'tie' ? 'menu' : 'defeat';
  }
  return screens.current === 'game' || screens.current === 'tutorial' ? 'match' : 'menu';
}

function syncMusicScene(): void {
  if (!settings.musicEnabled) return;
  music.play(currentMusicScene());
}

/* ----------------------------------------------------------------- settings */

const setSoundSwitch = bindSwitch(need<HTMLElement>('set-sound'), setSoundEnabled);
const setMusicSwitch = bindSwitch(need<HTMLElement>('set-music'), setMusicEnabled);

const musicVolumeInput = need<HTMLInputElement>('set-music-volume');
musicVolumeInput.addEventListener('input', () => {
  settings.musicVolume = Number(musicVolumeInput.value) / 100;
  music.setVolume(settings.musicVolume);
});
musicVolumeInput.addEventListener('change', () => saveSettings(settings));

const setCoordsSwitch = bindSwitch(need<HTMLElement>('set-coords'), (checked) => {
  settings.showCoordinates = checked;
  saveSettings(settings);
  renderer?.setCoordinatesVisible(checked);
});
const setUndoSwitch = bindSwitch(need<HTMLElement>('set-undo'), (checked) => {
  settings.allowUndoInLocalPlay = checked;
  saveSettings(settings);
  controller?.setLocalUndoAllowed(checked);
  syncControls();
});

const volumeInput = need<HTMLInputElement>('set-volume');
volumeInput.addEventListener('input', () => {
  settings.volume = Number(volumeInput.value) / 100;
  sound.setVolume(settings.volume);
});
volumeInput.addEventListener('change', () => {
  saveSettings(settings);
  sound.play('ui-tap');
});

const setMotionValue = bindSegmented(need<HTMLElement>('set-motion'), (value) => {
  settings.motion = value === 'full' || value === 'reduced' ? value : 'auto';
  saveSettings(settings);
  motion.setPreference(settings.motion);
  renderer?.setMotionEnabled(motion.enabled);
});

const setContrastValue = bindSegmented(need<HTMLElement>('set-contrast'), (value) => {
  settings.contrast = value === 'high' ? 'high' : 'auto';
  saveSettings(settings);
  app.setAttribute('data-contrast', settings.contrast);
});

function renderStatGrid(): void {
  const stats = loadStats();
  const grid = need<HTMLElement>('stat-grid');
  const entries: Array<[string, string]> = [
    ['Matches', String(stats.matchesCompleted)],
    ['Wins', String(stats.playerWins)],
    ['Losses', String(stats.computerWins)],
    ['Ties', String(stats.ties)],
    ['Best margin', String(stats.bestScoreDifference)],
    ['Biggest convert', String(stats.largestConversion)],
  ];
  grid.replaceChildren(
    ...entries.map(([term, value]) => {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      wrap.append(dt, dd);
      return wrap;
    }),
  );
}

need<HTMLButtonElement>('btn-reset-stats').addEventListener('click', () => {
  resetStats();
  renderStatGrid();
  updateMenuStats();
  announcer.say('Statistics reset.');
});

setSoundSwitch(settings.soundEnabled);
setMusicSwitch(settings.musicEnabled);
setCoordsSwitch(settings.showCoordinates);
setUndoSwitch(settings.allowUndoInLocalPlay);
setMotionValue(settings.motion);
setContrastValue(settings.contrast);
volumeInput.value = String(Math.round(settings.volume * 100));
musicVolumeInput.value = String(Math.round(settings.musicVolume * 100));
syncSoundUi();
syncMusicUi();

/* -------------------------------------------------------------- match setup */

function describeContext(): DescribeContext {
  const state = controller?.state;
  return {
    geo: controller?.geometry ?? getBoard(settings.boardId),
    mode: settings.mode,
    humanPlayer: controller?.humanPlayer ?? 1,
    currentPlayer: state?.currentPlayer ?? 1,
  };
}

function startMatch(options: { resume?: boolean } = {}): void {
  teardownMatch();

  const next = new GameController({
    mode: settings.mode,
    boardId: settings.boardId,
    difficulty: settings.difficulty,
    humanPlayer: 1,
  });
  next.setLocalUndoAllowed(settings.allowUndoInLocalPlay);
  next.setPacing(pacingForMotion(motion.enabled));
  next.setSeed(Number.isFinite(matchSeed) ? matchSeed : (Date.now() ^ 0x9e3779b9) >>> 0);
  controller = next;

  const boardRenderer = new BoardRenderer({
    geo: next.geometry,
    host: need<HTMLElement>('board-host'),
    label: `${next.geometry.name} board, ${next.geometry.playableCount} playable spaces`,
    describe: (index, state, target) =>
      describeCell(describeContext(), index, state, target, next.state.selectedCell === index),
  });
  boardRenderer.setMotionEnabled(motion.enabled);
  boardRenderer.setCoordinatesVisible(settings.showCoordinates);
  renderer = boardRenderer;

  detachBoard = [
    installBoardInput({
      renderer: boardRenderer,
      isEnabled: () => next.isInteractive() && screens.current === 'game' && !anyDialogOpen(),
      preferredTargets: () => {
        const { clone, jump } = next.targets;
        return [...clone, ...jump];
      },
      onActivate: (index) => next.activateCell(index),
    }),
    installKeyboardControls({
      renderer: boardRenderer,
      isEnabled: () => screens.current === 'game' && !anyDialogOpen(),
      onActivate: (index) => next.activateCell(index),
      onCancel: () => next.clearSelection(),
      onRestart: () => askRestart(),
      onFocusChange: (index) => {
        const state = next.state;
        const targets = next.targets;
        const target = targets.clone.includes(index)
          ? 'clone'
          : targets.jump.includes(index)
            ? 'jump'
            : null;
        announcer.say(
          describeCell(describeContext(), index, state.board[index]!, target, state.selectedCell === index),
        );
      },
    }),
    next.subscribe(onControllerEvent),
  ];

  previousScores = { player1: 0, player2: 0 };
  announcedPlayer = null;
  lastSummary = null;
  hidePeek();
  clearMoveLog();

  need<HTMLElement>('panel-board').textContent = next.geometry.name;
  need<HTMLElement>('panel-mode').textContent =
    settings.mode === 'vs-computer'
      ? `Vs Computer (${settings.difficulty})`
      : 'Two players, one device';

  next.start({ resume: options.resume === true });
  boardRenderer.setFocusCell(firstOwnPiece(next.state, next.humanPlayer), { focus: false });
  screens.show('game');
}

function teardownMatch(): void {
  for (const off of detachBoard) off();
  detachBoard = [];
  controller?.dispose();
  controller = null;
  renderer?.destroy();
  renderer = null;
  if (peekTimer !== null) clearTimeout(peekTimer);
  peekTimer = null;
}

function firstOwnPiece(state: GameState, player: PlayerId): number {
  const wanted = player === 1 ? 'player1' : 'player2';
  const index = state.board.findIndex((cell) => cell === wanted);
  return index >= 0 ? index : 0;
}

function anyDialogOpen(): boolean {
  return pauseDialog.isOpen || confirmDialog.isOpen || resultDialog.isOpen;
}

/* ---------------------------------------------------------- event handling */

function onControllerEvent(event: ControllerEvent): void {
  switch (event.type) {
    case 'state':
      draw(event.state);
      break;

    case 'selection':
      if (event.selected !== null) sound.play('select');
      break;

    case 'move':
      handleMove(event.move, event.state);
      break;

    case 'skipped': {
      const message = describeSkip(describeContext(), event.player);
      setHint(message, 'warn');
      announcer.alert(message);
      break;
    }

    case 'thinking':
      need<HTMLElement>('thinking').hidden = !event.active;
      need<HTMLElement>('turnpill').hidden = event.active;
      syncControls();
      break;

    case 'rejected':
      sound.play('invalid');
      if (event.reason === 'out-of-range' || event.reason === 'destination-not-empty') {
        setHint('That space is out of reach. Pick a highlighted space.', 'warn');
      }
      break;

    case 'undo':
      sound.play('ui-tap');
      setHint('Move taken back.');
      announcer.say('Move taken back.');
      clearMoveLog();
      break;

    case 'finished':
      lastSummary = event.summary;
      finishMatch(event.summary);
      break;
  }
}

function handleMove(move: Move, state: GameState): void {
  sound.play(move.type === 'clone' ? 'clone' : 'jump');
  appendMoveLog(move);
  announcer.say(describeMove(describeContext(), move, state.scores));

  if (move.type === 'jump') void renderer?.animateJump(move);
  if (move.converted.length > 0) {
    sound.playConversion(move.converted.length);
    renderer?.animateConversions(move);
  }
  if (state.status === 'playing') sound.play('turn-change');
}

function draw(state: GameState): void {
  if (!controller || !renderer) return;
  renderer.render(state, controller.targets, { animateArrival: true });

  for (const player of [1, 2] as const) {
    const chip = need<HTMLElement>(`score-p${player}`);
    const scoreNode = chip.querySelector<HTMLElement>('[data-score]');
    const value = player === 1 ? state.scores.player1 : state.scores.player2;
    if (scoreNode && scoreNode.textContent !== String(value)) {
      scoreNode.textContent = String(value);
      if ((player === 1 ? previousScores.player1 : previousScores.player2) !== value) {
        pulse(scoreNode, 'is-bumping', 200);
      }
    }
    chip.setAttribute(
      'data-active',
      String(state.status === 'playing' && state.currentPlayer === player),
    );
  }
  previousScores = { ...state.scores };

  const turnpill = need<HTMLElement>('turnpill');
  turnpill.setAttribute('data-player', String(state.currentPlayer));
  need<HTMLElement>('turnpill-text').textContent = turnLabel(state);

  need<HTMLElement>('panel-turn').textContent = String(state.turnNumber);
  need<HTMLElement>('panel-empty').textContent = String(countEmpty(state.board));

  if (state.status === 'playing') updateHintForState(state);
  syncControls();

  // Turn hand-offs are announced separately from moves so a screen-reader user
  // always hears "your turn" even when the opponent's move said nothing new.
  if (state.status === 'playing' && state.currentPlayer !== announcedPlayer) {
    announcedPlayer = state.currentPlayer;
    announcer.say(describeTurn(describeContext(), state.currentPlayer));
  } else if (state.status !== 'playing') {
    announcedPlayer = null;
  }
}

let announcedPlayer: PlayerId | null = null;

function turnLabel(state: GameState): string {
  if (state.status === 'finished') return 'Match over';
  if (settings.mode === 'local-two-player') return `${TEAM_NAMES[state.currentPlayer]}' turn`;
  return state.currentPlayer === 1 ? 'Your turn' : "Opponent's turn";
}

function updateHintForState(state: GameState): void {
  if (!controller) return;
  if (!controller.isInteractive()) {
    setHint(settings.mode === 'vs-computer' ? 'Opponent is choosing a move…' : 'Waiting…');
    return;
  }
  if (state.selectedCell === null) {
    setHint(
      settings.mode === 'local-two-player'
        ? `${TEAM_NAMES[state.currentPlayer]}: tap one of your monsters.`
        : 'Tap one of your monsters.',
    );
    return;
  }
  const { clone, jump } = controller.targets;
  setHint(`Tap a dot to clone (${clone.length}) or a ring to jump (${jump.length}). Tap again to cancel.`);
}

function setHint(text: string, tone: 'neutral' | 'warn' | 'good' = 'neutral'): void {
  const hint = need<HTMLElement>('hintbar');
  hint.textContent = text;
  hint.setAttribute('data-tone', tone);
}

function syncControls(): void {
  const undo = need<HTMLButtonElement>('btn-undo');
  undo.disabled = !controller?.canUndo();
}

/* ------------------------------------------------------------------ move log */

const moveLog = need<HTMLElement>('movelog');

function clearMoveLog(): void {
  moveLog.replaceChildren();
}

function appendMoveLog(move: Move): void {
  const to = controller?.geometry.cells[move.to];
  if (!to) return;
  const item = document.createElement('li');
  item.dataset.player = String(move.player);
  const verb = move.type === 'clone' ? 'Clone' : 'Jump';
  const flips = move.converted.length > 0 ? ` +${move.converted.length}` : '';
  item.textContent = `${move.turnNumber}. ${TEAM_NAMES[move.player]} ${verb} → r${to.row}c${to.col}${flips}`;
  moveLog.prepend(item);
  while (moveLog.childElementCount > 14) moveLog.lastElementChild?.remove();
}

/* -------------------------------------------------------------- end of game */

function finishMatch(summary: MatchSummary): void {
  const ctx = describeContext();
  const message = describeResult(ctx, summary.winner, summary.scores, summary.label);
  announcer.alert(message);
  setHint(message, summary.winner === 'tie' ? 'neutral' : 'good');

  if (settings.mode === 'vs-computer') {
    sound.play(summary.winner === 'tie' ? 'tie' : summary.winner === 1 ? 'win' : 'lose');
  } else {
    sound.play(summary.winner === 'tie' ? 'tie' : 'win');
  }

  need<HTMLElement>('thinking').hidden = true;
  need<HTMLElement>('turnpill').hidden = false;
  updateMenuStats();
  renderStatGrid();
  syncMusicScene();

  // The final board is the most interesting thing on screen, so it is left
  // visible for a beat and the result sheet is offered rather than forced.
  showPeek();
  peekTimer = setTimeout(() => openResult(summary), 2600);
}

function showPeek(): void {
  const peek = need<HTMLElement>('result-peek');
  peek.hidden = false;
}

function hidePeek(): void {
  need<HTMLElement>('result-peek').hidden = true;
  if (peekTimer !== null) clearTimeout(peekTimer);
  peekTimer = null;
}

need<HTMLButtonElement>('result-peek').addEventListener('click', () => {
  if (lastSummary) openResult(lastSummary);
});

function openResult(summary: MatchSummary): void {
  hidePeek();
  if (resultDialog.isOpen) return;

  need<HTMLElement>('result-label').textContent = summary.label;

  const title =
    summary.winner === 'tie'
      ? "It's a tie"
      : settings.mode === 'vs-computer'
        ? summary.winner === 1
          ? 'You win!'
          : 'Computer wins'
        : `${TEAM_NAMES[summary.winner]} win!`;
  need<HTMLElement>('result-title').textContent = title;

  const scores = need<HTMLElement>('result-scores');
  scores.replaceChildren();
  for (const player of [1, 2] as const) {
    if (player === 2) {
      const vs = document.createElement('span');
      vs.className = 'result__vs';
      vs.textContent = 'vs';
      scores.appendChild(vs);
    }
    const team = document.createElement('div');
    team.className = 'result__team';
    team.appendChild(createMonsterBadge(player, 46));
    const value = document.createElement('span');
    value.className = 'result__team-score';
    value.textContent = String(player === 1 ? summary.scores.player1 : summary.scores.player2);
    const name = document.createElement('span');
    name.className = 'result__team-name';
    name.textContent =
      settings.mode === 'vs-computer' ? (player === 1 ? 'You' : 'Computer') : TEAM_NAMES[player];
    team.append(value, name);
    scores.appendChild(team);
  }

  const stats = need<HTMLElement>('result-stats');
  const entries: Array<[string, string]> = [
    ['Turns', String(summary.turns)],
    ['Duration', formatDuration(summary.durationMs)],
    ['Biggest convert', String(summary.largestConversion)],
    ['Board', getBoard(summary.boardId).name],
  ];
  stats.replaceChildren(
    ...entries.map(([term, value]) => {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      wrap.append(dt, dd);
      return wrap;
    }),
  );

  resultDialog.open({ dismissible: true });
}

/* ----------------------------------------------------------------- controls */

need<HTMLButtonElement>('btn-play').addEventListener('click', () => {
  void sound.unlock();
  startMatch();
});

const resumeButton = need<HTMLButtonElement>('btn-resume');
resumeButton.addEventListener('click', () => {
  void sound.unlock();
  startMatch({ resume: true });
});

function refreshResumeButton(): void {
  resumeButton.hidden = !GameController.hasResumableMatch(settings.boardId);
}
refreshResumeButton();

need<HTMLButtonElement>('btn-howto').addEventListener('click', () => screens.show('howto'));
need<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
  renderStatGrid();
  screens.show('settings');
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close-screen]')) {
  button.addEventListener('click', () => screens.back('menu'));
}

need<HTMLButtonElement>('btn-pause').addEventListener('click', () => {
  pauseDialog.open();
});
need<HTMLButtonElement>('btn-pause-resume').addEventListener('click', () => pauseDialog.close());
need<HTMLButtonElement>('btn-pause-restart').addEventListener('click', () => {
  pauseDialog.close();
  askRestart();
});
need<HTMLButtonElement>('btn-pause-settings').addEventListener('click', () => {
  pauseDialog.close();
  renderStatGrid();
  screens.show('settings');
});
need<HTMLButtonElement>('btn-pause-menu').addEventListener('click', () => {
  pauseDialog.close();
  goToMenu();
});

need<HTMLButtonElement>('btn-restart').addEventListener('click', () => askRestart());
need<HTMLButtonElement>('btn-undo').addEventListener('click', () => {
  controller?.undo();
});

let confirmAction: (() => void) | null = null;

function askConfirm(title: string, body: string, action: () => void): void {
  need<HTMLElement>('confirm-title').textContent = title;
  need<HTMLElement>('confirm-body').textContent = body;
  confirmAction = action;
  confirmDialog.open({ initialFocus: need<HTMLElement>('btn-confirm-cancel') });
}

function askRestart(): void {
  if (!controller || screens.current !== 'game') return;
  if (controller.state.status === 'finished') {
    controller.restart();
    return;
  }
  askConfirm('Restart match?', 'The current board will be lost.', () => controller?.restart());
}

need<HTMLButtonElement>('btn-confirm-cancel').addEventListener('click', () => {
  confirmAction = null;
  confirmDialog.close();
});
need<HTMLButtonElement>('btn-confirm-ok').addEventListener('click', () => {
  const action = confirmAction;
  confirmAction = null;
  confirmDialog.close();
  action?.();
});

need<HTMLButtonElement>('btn-result-again').addEventListener('click', () => {
  resultDialog.close();
  startMatch();
});
need<HTMLButtonElement>('btn-result-board').addEventListener('click', () => {
  resultDialog.close();
  goToMenu();
  need<HTMLElement>('board-picker').querySelector<HTMLElement>('[role="radio"]')?.focus();
});
need<HTMLButtonElement>('btn-result-menu').addEventListener('click', () => {
  resultDialog.close();
  goToMenu();
});

function goToMenu(): void {
  teardownMatch();
  hidePeek();
  updateMenuStats();
  refreshResumeButton();
  announcer.clear();
  screens.show('menu', { remember: false });
}

/* ----------------------------------------------------------------- tutorial */

const tutorial = new Tutorial({
  host: need<HTMLElement>('tutorial-host'),
  stepLabel: need<HTMLElement>('tutorial-step'),
  hintLabel: need<HTMLElement>('tutorial-hint'),
  nextButton: need<HTMLButtonElement>('btn-tutorial-next'),
  backButton: need<HTMLButtonElement>('btn-tutorial-back'),
  announcer,
  sound,
  motionEnabled: () => motion.enabled,
  onFinish: (completed) => {
    if (completed) {
      settings.tutorialCompleted = true;
      saveSettings(settings);
      trackEvent('tutorial_completed');
    }
    screens.show('menu', { remember: false });
  },
});

need<HTMLButtonElement>('btn-tutorial').addEventListener('click', () => {
  void sound.unlock();
  trackEvent('tutorial_started');
  screens.show('tutorial');
  tutorial.start();
});
need<HTMLButtonElement>('btn-tutorial-next').addEventListener('click', () => tutorial.next());
need<HTMLButtonElement>('btn-tutorial-back').addEventListener('click', () => tutorial.back());
need<HTMLButtonElement>('btn-tutorial-skip').addEventListener('click', () => tutorial.stop(false));

screens.onChange((screen) => {
  if (screen !== 'tutorial' && tutorial.isActive) tutorial.stop(false);
  if (screen === 'menu') refreshResumeButton();
  syncMusicScene();
});

motion.onChange((enabled) => {
  renderSky(need<HTMLElement>('menu-motes'), { enabled });
  renderer?.setMotionEnabled(enabled);
  controller?.setPacing(pacingForMotion(enabled));
});

/* ------------------------------------------------------- lifecycle & offline */

// A rotation or a tab switch must never lose the match. The controller writes a
// save after every move; this is a belt-and-braces flush for backgrounding.
function armAudioOnFirstGesture(): void {
  const start = (): void => {
    void sound.unlock().then(() => {
      if (settings.musicEnabled) music.play(currentMusicScene());
    });
  };
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, start, { once: true, capture: true });
  }
}
armAudioOnFirstGesture();

document.addEventListener('visibilitychange', () => {
  // A soundtrack playing to a backgrounded tab is just battery drain.
  if (document.visibilityState === 'hidden') music.suspend();
  else music.resume();

  if (document.visibilityState === 'hidden' && controller?.state.status === 'playing') {
    refreshResumeButton();
  }
});

window.addEventListener('orientationchange', () => {
  // The board is laid out with a viewBox, so nothing needs re-measuring — but
  // the focused space should stay in view.
  const index = renderer?.focusIndex ?? -1;
  if (index >= 0) renderer?.setFocusCell(index);
});

const updateToast = need<HTMLElement>('update-toast');
const swHandle = registerServiceWorker({
  onUpdateReady: () => {
    updateToast.hidden = false;
  },
});
need<HTMLButtonElement>('btn-update').addEventListener('click', () => {
  updateToast.hidden = true;
  swHandle?.applyUpdate();
});

// First run: nudge new players towards the tutorial instead of the deep end.
if (!settings.tutorialCompleted && loadStats().matchesPlayed === DEFAULT_STATS.matchesPlayed) {
  need<HTMLElement>('menu-stats').textContent = 'New here? The tutorial takes under a minute.';
}

screens.show('menu', { remember: false });

// `?start=1` jumps straight into a match. Used by deep links and by the
// end-to-end suite, which needs a known board without menu choreography.
if (params.get('start') === '1') {
  startMatch({ resume: params.get('resume') === '1' });
}

// The inline watchdog in index.html shows a "could not start" notice unless
// this flag appears, which is the only reliable signal that the module graph
// actually executed.
declare global {
  interface Window {
    __monsterTerritoryBooted?: boolean;
  }
}
window.__monsterTerritoryBooted = true;
