/**
 * Match orchestration: owns the authoritative `GameState`, drives the computer
 * opponent, keeps match statistics and broadcasts everything the UI needs.
 *
 * The controller never touches the DOM. The UI subscribes to events and renders
 * whatever it is told, which keeps rule handling out of event handlers.
 */

import { AiClient, type AiDecision } from '../ai/ai-client.ts';
import type { Difficulty } from '../ai/types.ts';
import { MIN_THINKING_MS } from '../ai/types.ts';
import { getBoard } from '../data/boards.ts';
import {
  clearSavedGame,
  durationBucket,
  readSavedGame,
  trackEvent,
  updateStats,
  writeSavedGame,
  type GameMode,
} from '../data/settings.ts';
import type { BoardGeometry } from './board.ts';
import { deserialiseGame, serialiseGame } from './game-state.ts';
import { getMoveTargets, type MoveTargets } from './moves.ts';
import { applyMove, createInitialState, validateMove, type MoveRejection } from './rules.ts';
import { opponentOf, type GameState, type Move, type PlayerId } from './types.ts';

export interface MatchConfig {
  mode: GameMode;
  boardId: string;
  difficulty: Difficulty;
  /** Which side the human plays in `vs-computer`. Player 1 in version one. */
  humanPlayer: PlayerId;
}

export interface MatchSummary {
  winner: PlayerId | 'tie';
  scores: { player1: number; player2: number };
  turns: number;
  durationMs: number;
  largestConversion: number;
  /** Short celebratory label, e.g. "Total takeover". */
  label: string;
  mode: GameMode;
  boardId: string;
  difficulty: Difficulty;
}

export type ControllerEvent =
  | { type: 'state'; state: GameState }
  | { type: 'move'; move: Move; state: GameState }
  | { type: 'skipped'; player: PlayerId; state: GameState }
  | { type: 'selection'; selected: number | null; targets: MoveTargets }
  | { type: 'thinking'; active: boolean }
  | { type: 'rejected'; reason: MoveRejection; index: number }
  | { type: 'finished'; summary: MatchSummary; state: GameState }
  | { type: 'undo'; state: GameState };

type Listener = (event: ControllerEvent) => void;

const EMPTY_TARGETS: MoveTargets = { clone: [], jump: [] };

/** How long the board is left alone after a move before the opponent replies. */
export interface Pacing {
  moveSettleMs: number;
}

export class GameController {
  #geo: BoardGeometry;
  #state: GameState;
  #config: MatchConfig;
  #listeners = new Set<Listener>();
  #ai = new AiClient();
  #thinking = false;
  #aiToken = 0;
  #history: GameState[] = [];
  #undoAvailable = false;
  #pacing: Pacing = { moveSettleMs: 280 };
  #startedAt = 0;
  #largestConversion = 0;
  #peakDeficit = { 1: 0, 2: 0 } as Record<PlayerId, number>;
  #finished = false;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #seed = 1;

  constructor(config: MatchConfig) {
    this.#config = { ...config };
    this.#geo = getBoard(config.boardId);
    this.#state = createInitialState(this.#geo);
    this.#startedAt = Date.now();
  }

  // -- subscription ---------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: ControllerEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  // -- accessors ------------------------------------------------------------

  get state(): GameState {
    return this.#state;
  }

  get geometry(): BoardGeometry {
    return this.#geo;
  }

  get config(): MatchConfig {
    return { ...this.#config };
  }

  get isThinking(): boolean {
    return this.#thinking;
  }

  get humanPlayer(): PlayerId {
    return this.#config.humanPlayer;
  }

  /** True when the space belongs to whoever the local device controls now. */
  isInteractive(): boolean {
    if (this.#state.status !== 'playing' || this.#thinking) return false;
    if (this.#config.mode === 'local-two-player') return true;
    return this.#state.currentPlayer === this.#config.humanPlayer;
  }

  setPacing(pacing: Partial<Pacing>): void {
    this.#pacing = { ...this.#pacing, ...pacing };
  }

  setSeed(seed: number): void {
    this.#seed = seed >>> 0 || 1;
  }

  get targets(): MoveTargets {
    if (this.#state.selectedCell === null) return EMPTY_TARGETS;
    return getMoveTargets(this.#geo, this.#state.board, this.#state.selectedCell, this.#state.currentPlayer);
  }

  // -- lifecycle ------------------------------------------------------------

  /** Starts (or restarts) a match. */
  start(options: { resume?: boolean; countAsNew?: boolean } = {}): void {
    this.#cancelTimers();
    this.#aiToken++;
    this.#setThinking(false);
    this.#finished = false;
    this.#history = [];
    this.#undoAvailable = false;
    this.#largestConversion = 0;
    this.#peakDeficit = { 1: 0, 2: 0 };
    this.#startedAt = Date.now();

    let restored: GameState | null = null;
    if (options.resume) restored = deserialiseGame(readSavedGame(), this.#geo);

    this.#state = restored ?? createInitialState(this.#geo);
    if (!restored && options.countAsNew !== false) {
      trackEvent('game_started');
      trackEvent('board_selected', this.#config.boardId);
      if (this.#config.mode === 'vs-computer') trackEvent('difficulty_selected', this.#config.difficulty);
      updateStats((s) => ({
        ...s,
        matchesPlayed: s.matchesPlayed + 1,
        localMatches: this.#config.mode === 'local-two-player' ? s.localMatches + 1 : s.localMatches,
      }));
    }

    this.#persist();
    this.#emit({ type: 'state', state: this.#state });
    this.#emit({ type: 'selection', selected: null, targets: EMPTY_TARGETS });

    if (this.#state.status === 'finished') {
      this.#finished = true;
      this.#emit({ type: 'finished', summary: this.#buildSummary(), state: this.#state });
      return;
    }
    this.#ai.warmUp();
    this.#maybeRunAi();
  }

  /** True when a saved, unfinished match exists for the configured layout. */
  static hasResumableMatch(boardId: string): boolean {
    try {
      const state = deserialiseGame(readSavedGame(), getBoard(boardId));
      return state !== null && state.status === 'playing';
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.#cancelTimers();
    this.#aiToken++;
    this.#listeners.clear();
    this.#ai.dispose();
  }

  // -- interaction ----------------------------------------------------------

  /**
   * Handles a tap, click or keyboard activation on a space. Selection state is
   * the controller's business; the UI just forwards the index.
   */
  activateCell(index: number): void {
    if (!this.isInteractive()) return;
    if (index < 0 || index >= this.#state.board.length) return;

    const player = this.#state.currentPlayer;
    const board = this.#state.board;
    const selected = this.#state.selectedCell;

    // Tapping the selected monster again cancels.
    if (selected === index) {
      this.clearSelection();
      return;
    }

    // Tapping any of your own monsters (re)selects it, even mid-selection.
    if (board[index] === (player === 1 ? 'player1' : 'player2')) {
      this.#state = { ...this.#state, selectedCell: index };
      this.#emit({ type: 'state', state: this.#state });
      this.#emit({ type: 'selection', selected: index, targets: this.targets });
      return;
    }

    if (selected === null) {
      this.#emit({ type: 'rejected', reason: 'not-your-piece', index });
      return;
    }

    const rejection = validateMove(this.#geo, this.#state, selected, index);
    if (rejection !== null) {
      // An invalid destination is ignored: the selection survives so a mis-tap
      // never costs a turn.
      this.#emit({ type: 'rejected', reason: rejection, index });
      return;
    }

    this.playMove(selected, index);
  }

  clearSelection(): void {
    if (this.#state.selectedCell === null) return;
    this.#state = { ...this.#state, selectedCell: null };
    this.#emit({ type: 'state', state: this.#state });
    this.#emit({ type: 'selection', selected: null, targets: EMPTY_TARGETS });
  }

  select(index: number | null): void {
    if (index === null) {
      this.clearSelection();
      return;
    }
    this.activateCell(index);
  }

  /** Plays a validated move. Throws if the move is illegal. */
  playMove(from: number, to: number): void {
    const previous = this.#state;
    const result = applyMove(this.#geo, previous, from, to);

    this.#history.push(previous);
    if (this.#history.length > 40) this.#history.shift();

    this.#state = result.state;
    this.#largestConversion = Math.max(this.#largestConversion, result.move.converted.length);
    this.#trackDeficit();
    this.#persist();

    this.#emit({ type: 'move', move: result.move, state: this.#state });
    this.#emit({ type: 'state', state: this.#state });
    this.#emit({ type: 'selection', selected: null, targets: EMPTY_TARGETS });

    for (const skipped of result.skipped) {
      this.#emit({ type: 'skipped', player: skipped, state: this.#state });
    }

    if (result.gameOver) {
      this.#finish();
      return;
    }

    // A human turn opens a fresh undo allowance.
    if (this.#config.mode === 'vs-computer' && this.#state.currentPlayer === this.#config.humanPlayer) {
      this.#undoAvailable = true;
    }

    this.#maybeRunAi();
  }

  // -- undo / restart -------------------------------------------------------

  canUndo(): boolean {
    if (this.#state.status !== 'playing' || this.#thinking) return false;
    if (this.#history.length === 0) return false;
    if (this.#config.mode === 'local-two-player') return this.#allowLocalUndo;
    return this.#undoAvailable && this.#state.currentPlayer === this.#config.humanPlayer;
  }

  #allowLocalUndo = false;

  setLocalUndoAllowed(allowed: boolean): void {
    this.#allowLocalUndo = allowed;
  }

  /**
   * Steps back to the position before the local player's previous move,
   * discarding the opponent's reply along the way.
   */
  undo(): boolean {
    if (!this.canUndo()) return false;
    this.#cancelTimers();
    this.#aiToken++;
    this.#setThinking(false);

    const target =
      this.#config.mode === 'local-two-player'
        ? this.#history.pop()!
        : this.#rewindToLocalTurn();

    this.#state = { ...target, selectedCell: null };
    this.#undoAvailable = false;
    this.#persist();
    trackEvent('undo_used');

    this.#emit({ type: 'undo', state: this.#state });
    this.#emit({ type: 'state', state: this.#state });
    this.#emit({ type: 'selection', selected: null, targets: EMPTY_TARGETS });
    this.#maybeRunAi();
    return true;
  }

  #rewindToLocalTurn(): GameState {
    let candidate = this.#history.pop()!;
    while (candidate.currentPlayer !== this.#config.humanPlayer && this.#history.length > 0) {
      candidate = this.#history.pop()!;
    }
    return candidate;
  }

  restart(): void {
    updateStats((s) => ({ ...s, restartsUsed: s.restartsUsed + 1 }));
    trackEvent('restart_used');
    clearSavedGame();
    this.start();
  }

  /** Swaps layout, mode or difficulty and begins a new match. */
  reconfigure(config: Partial<MatchConfig>): void {
    this.#cancelTimers();
    this.#aiToken++;
    this.#config = { ...this.#config, ...config };
    this.#geo = getBoard(this.#config.boardId);
    clearSavedGame();
    this.start();
  }

  // -- computer opponent ----------------------------------------------------

  #maybeRunAi(): void {
    if (this.#config.mode !== 'vs-computer') return;
    if (this.#state.status !== 'playing') return;
    const aiPlayer = opponentOf(this.#config.humanPlayer);
    if (this.#state.currentPlayer !== aiPlayer) return;

    const token = ++this.#aiToken;
    this.#setThinking(true);

    // Let the previous move's animation land before the opponent replies.
    this.#defer(async () => {
      if (token !== this.#aiToken) return;
      const startedAt = Date.now();
      let decision: AiDecision | null = null;
      try {
        decision = await this.#ai.decide(
          this.#geo,
          this.#state.board,
          aiPlayer,
          this.#config.difficulty,
          this.#nextSeed(),
        );
      } catch {
        decision = null;
      }
      if (token !== this.#aiToken) return;

      if (!decision) {
        // No legal move: the rules engine already handled the skip, so there is
        // nothing left to play. Guard against a stuck "Thinking..." indicator.
        this.#setThinking(false);
        return;
      }

      // Guarantee a beat of visible thinking so turns never feel like a glitch.
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, MIN_THINKING_MS - elapsed);
      this.#defer(() => {
        if (token !== this.#aiToken) return;
        this.#setThinking(false);
        if (this.#state.status !== 'playing' || this.#state.currentPlayer !== aiPlayer) return;
        this.playMove(decision!.move.from, decision!.move.to);
      }, wait);
    }, this.#pacing.moveSettleMs);
  }

  #nextSeed(): number {
    // Deterministic per match, varied per turn.
    this.#seed = (this.#seed * 1664525 + 1013904223) >>> 0;
    return this.#seed;
  }

  #setThinking(active: boolean): void {
    if (this.#thinking === active) return;
    this.#thinking = active;
    this.#emit({ type: 'thinking', active });
  }

  // -- results --------------------------------------------------------------

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#cancelTimers();
    this.#setThinking(false);
    clearSavedGame();

    const summary = this.#buildSummary();
    const diff = Math.abs(summary.scores.player1 - summary.scores.player2);

    updateStats((s) => {
      const humanWon =
        this.#config.mode === 'vs-computer' && summary.winner === this.#config.humanPlayer;
      const computerWon =
        this.#config.mode === 'vs-computer' && summary.winner === opponentOf(this.#config.humanPlayer);
      return {
        ...s,
        matchesCompleted: s.matchesCompleted + 1,
        playerWins: humanWon ? s.playerWins + 1 : s.playerWins,
        computerWins: computerWon ? s.computerWins + 1 : s.computerWins,
        ties: summary.winner === 'tie' ? s.ties + 1 : s.ties,
        bestScoreDifference: Math.max(s.bestScoreDifference, humanWon ? diff : 0),
        largestConversion: Math.max(s.largestConversion, summary.largestConversion),
        fastestWinMs: humanWon
          ? s.fastestWinMs === null
            ? summary.durationMs
            : Math.min(s.fastestWinMs, summary.durationMs)
          : s.fastestWinMs,
      };
    });

    trackEvent('game_completed');
    trackEvent('match_duration_bucket', durationBucket(summary.durationMs));
    if (this.#config.mode === 'vs-computer') {
      if (summary.winner === this.#config.humanPlayer) trackEvent('player_victory');
      else if (summary.winner === 'tie') trackEvent('tie_result');
      else trackEvent('computer_victory');
    } else if (summary.winner === 'tie') {
      trackEvent('tie_result');
    }

    this.#emit({ type: 'finished', summary, state: this.#state });
  }

  #buildSummary(): MatchSummary {
    const scores = this.#state.scores;
    const winner = this.#state.winner ?? 'tie';
    return {
      winner,
      scores,
      turns: Math.max(1, this.#state.turnNumber - 1),
      durationMs: Date.now() - this.#startedAt,
      largestConversion: this.#largestConversion,
      label: this.#resultLabel(winner, scores),
      mode: this.#config.mode,
      boardId: this.#config.boardId,
      difficulty: this.#config.difficulty,
    };
  }

  #resultLabel(winner: PlayerId | 'tie', scores: { player1: number; player2: number }): string {
    if (winner === 'tie') return 'Dead heat';
    const winnerScore = winner === 1 ? scores.player1 : scores.player2;
    const loserScore = winner === 1 ? scores.player2 : scores.player1;
    const diff = winnerScore - loserScore;

    if (loserScore === 0) return 'Total takeover';
    if (this.#peakDeficit[winner] >= 6) return 'Comeback victory';
    if (diff <= 2) return 'Close call';
    if (this.#largestConversion >= 5) return 'Perfect trap';
    if (diff >= 20) return 'Territory master';
    return 'Territory claimed';
  }

  #trackDeficit(): void {
    const { player1, player2 } = this.#state.scores;
    this.#peakDeficit[1] = Math.max(this.#peakDeficit[1], player2 - player1);
    this.#peakDeficit[2] = Math.max(this.#peakDeficit[2], player1 - player2);
  }

  // -- persistence ----------------------------------------------------------

  #persist(): void {
    if (this.#state.status === 'finished') clearSavedGame();
    else writeSavedGame(serialiseGame(this.#state));
  }

  // -- timers ---------------------------------------------------------------

  #defer(fn: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, delay);
    this.#timers.add(timer);
  }

  #cancelTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
}
