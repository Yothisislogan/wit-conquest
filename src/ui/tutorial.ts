/**
 * The interactive tutorial: five short steps on a 19-space training board.
 *
 * It drives the real renderer and the real rules engine — nothing here is
 * faked — but it runs its own tiny state machine instead of `GameController`,
 * because a lesson needs to reset the board between steps and gate progress on
 * a *kind* of move rather than on a whole match.
 *
 * A step advances the moment the player does the thing it asks for; "Next" is
 * always available so nobody can get stuck, and "Skip" leaves at any point.
 */

import { getTutorialBoard } from '../data/boards.ts';
import { hexId } from '../game/hex.ts';
import { applyMoveToBoard, classifyMove, getConversions, getMoveTargets } from '../game/moves.ts';
import type { Axial, CellState, GameState, Move } from '../game/types.ts';
import { describeCell, type Announcer, type DescribeContext } from '../accessibility/announcements.ts';
import { installKeyboardControls } from '../accessibility/keyboard-controls.ts';
import { BoardRenderer } from './board-renderer.ts';
import { installBoardInput } from './input-controller.ts';
import type { SoundController } from './sound-controller.ts';

interface TutorialStep {
  title: string;
  hint: string;
  /** Pieces placed before the step begins. */
  setup: { player1: Axial[]; player2: Axial[] };
  /** What the player has to do to move on. */
  goal: 'select' | 'clone' | 'jump' | 'convert' | 'none';
  /** Shown once the goal is met, before auto-advancing. */
  success: string;
}

const STEPS: TutorialStep[] = [
  {
    title: 'Pick a monster',
    hint: 'Tap your blue monster. Every space it can reach lights up.',
    setup: { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] },
    goal: 'select',
    success: 'That is it. Solid dots are clones, hollow rings are jumps.',
  },
  {
    title: 'Clone to a neighbour',
    hint: 'Tap a space with a solid dot — right next to your monster. Your monster stays and a copy appears.',
    setup: { player1: [{ q: 0, r: 0 }], player2: [{ q: 0, r: 2 }] },
    goal: 'clone',
    success: 'Two monsters from one. Cloning is how you grow.',
  },
  {
    title: 'Jump across',
    hint: 'Now tap a space with a hollow ring, two steps away. Your monster leaps there and leaves its space empty.',
    setup: { player1: [{ q: -2, r: 1 }], player2: [{ q: 2, r: -1 }] },
    goal: 'jump',
    success: 'Jumping covers ground, but you do not gain a monster.',
  },
  {
    title: 'Convert the enemy',
    hint: 'Move so you land touching an orange monster. Every enemy touching where you land joins your team.',
    setup: {
      player1: [{ q: 0, r: 1 }],
      player2: [
        { q: 1, r: -1 },
        { q: -1, r: 0 },
      ],
    },
    goal: 'convert',
    success: 'Both flipped at once. Landing between enemies is the strongest move in the game.',
  },
  {
    title: 'Claim the board',
    hint: 'When nobody can move, the biggest team wins. That is the whole game — go take a board.',
    setup: {
      player1: [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 0, r: 1 },
        { q: -1, r: 1 },
        { q: 1, r: -1 },
        { q: -1, r: 0 },
        { q: 0, r: -1 },
        { q: 2, r: -1 },
      ],
      player2: [
        { q: -2, r: 2 },
        { q: -1, r: 2 },
        { q: 0, r: 2 },
      ],
    },
    goal: 'none',
    success: '',
  },
];

export interface TutorialOptions {
  host: HTMLElement;
  stepLabel: HTMLElement;
  hintLabel: HTMLElement;
  nextButton: HTMLButtonElement;
  backButton: HTMLButtonElement;
  announcer: Announcer;
  sound: SoundController;
  motionEnabled: () => boolean;
  onFinish: (completed: boolean) => void;
}

export class Tutorial {
  #options: TutorialOptions;
  #geo = getTutorialBoard();
  #renderer: BoardRenderer | null = null;
  #teardown: Array<() => void> = [];
  #board: CellState[] = [];
  #selected: number | null = null;
  #lastMove: Move | null = null;
  #step = 0;
  #satisfied = false;
  #active = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TutorialOptions) {
    this.#options = options;
  }

  get isActive(): boolean {
    return this.#active;
  }

  start(): void {
    this.#active = true;
    this.#step = 0;
    this.#mount();
    this.#loadStep(0);
  }

  stop(completed: boolean): void {
    if (!this.#active) return;
    this.#active = false;
    this.#clearTimer();
    for (const off of this.#teardown) off();
    this.#teardown = [];
    this.#renderer?.destroy();
    this.#renderer = null;
    this.#options.onFinish(completed);
  }

  next(): void {
    if (this.#step >= STEPS.length - 1) {
      this.stop(true);
      return;
    }
    this.#loadStep(this.#step + 1);
  }

  back(): void {
    if (this.#step === 0) {
      this.stop(false);
      return;
    }
    this.#loadStep(this.#step - 1);
  }

  #mount(): void {
    const ctx = (): DescribeContext => ({
      geo: this.#geo,
      mode: 'vs-computer',
      humanPlayer: 1,
      currentPlayer: 1,
    });

    const renderer = new BoardRenderer({
      geo: this.#geo,
      host: this.#options.host,
      label: 'Tutorial board',
      describe: (index, state, target) =>
        describeCell(ctx(), index, state, target, this.#selected === index),
    });
    renderer.setMotionEnabled(this.#options.motionEnabled());
    this.#renderer = renderer;

    this.#teardown.push(
      installBoardInput({
        renderer,
        isEnabled: () => this.#active,
        preferredTargets: () => this.#targets(),
        onActivate: (index) => this.#activate(index),
      }),
    );

    this.#teardown.push(
      installKeyboardControls({
        renderer,
        isEnabled: () => this.#active,
        onActivate: (index) => this.#activate(index),
        onCancel: () => {
          this.#selected = null;
          this.#draw();
        },
        onRestart: () => this.#loadStep(this.#step),
      }),
    );
  }

  #loadStep(index: number): void {
    this.#clearTimer();
    this.#step = index;
    this.#satisfied = false;
    this.#selected = null;
    this.#lastMove = null;

    const step = STEPS[index]!;
    this.#board = this.#geo.initialBoard.map((state) => (state === 'blocked' ? 'blocked' : 'empty'));
    for (const coord of step.setup.player1) this.#place(coord, 'player1');
    for (const coord of step.setup.player2) this.#place(coord, 'player2');

    this.#options.stepLabel.textContent = `Step ${index + 1} of ${STEPS.length} — ${step.title}`;
    this.#options.hintLabel.textContent = step.hint;
    this.#options.backButton.textContent = index === 0 ? 'Quit' : 'Back';
    this.#options.nextButton.textContent = index === STEPS.length - 1 ? 'Start playing' : 'Next';

    this.#renderer?.setFocusCell(this.#firstOwnPiece(), { focus: false });
    this.#draw();
    this.#options.announcer.say(`${step.title}. ${step.hint}`);
  }

  #place(coord: Axial, state: CellState): void {
    const index = this.#geo.indexById.get(hexId(coord.q, coord.r));
    if (index !== undefined) this.#board[index] = state;
  }

  #firstOwnPiece(): number {
    const index = this.#board.findIndex((state) => state === 'player1');
    return index >= 0 ? index : 0;
  }

  #targets(): number[] {
    if (this.#selected === null) return [];
    const { clone, jump } = getMoveTargets(this.#geo, this.#board, this.#selected, 1);
    return [...clone, ...jump];
  }

  #activate(index: number): void {
    if (!this.#active) return;
    const step = STEPS[this.#step]!;
    if (step.goal === 'none') return;

    if (this.#board[index] === 'player1') {
      this.#selected = this.#selected === index ? null : index;
      this.#options.sound.play(this.#selected === null ? 'deselect' : 'select');
      this.#draw();
      if (this.#selected !== null && step.goal === 'select') this.#satisfy(step);
      return;
    }

    if (this.#selected === null) return;
    const type = classifyMove(this.#geo, this.#board, this.#selected, index, 1);
    if (type === null) {
      this.#options.sound.play('invalid');
      return;
    }

    const converted = getConversions(this.#geo, this.#board, index, 1);
    applyMoveToBoard(this.#geo, this.#board, { from: this.#selected, to: index, type }, 1);
    this.#lastMove = {
      from: this.#selected,
      to: index,
      type,
      player: 1,
      converted,
      turnNumber: this.#step + 1,
    };
    this.#selected = null;
    this.#options.sound.play(type === 'clone' ? 'clone' : 'jump');
    this.#draw();

    if (converted.length > 0) {
      this.#options.sound.playConversion(converted.length);
      this.#renderer?.animateConversions(this.#lastMove);
    }

    const met =
      (step.goal === 'clone' && type === 'clone') ||
      (step.goal === 'jump' && type === 'jump') ||
      (step.goal === 'convert' && converted.length > 0);

    if (met) this.#satisfy(step);
    else if (step.goal === 'convert') {
      this.#options.hintLabel.textContent = 'Almost — try landing on a space that touches an orange monster.';
      this.#timer = setTimeout(() => this.#loadStep(this.#step), 1400);
    }
  }

  #satisfy(step: TutorialStep): void {
    if (this.#satisfied) return;
    this.#satisfied = true;
    this.#options.hintLabel.textContent = step.success;
    this.#options.announcer.say(step.success);
    // Give the player a beat to see what happened before moving on.
    this.#timer = setTimeout(() => {
      if (this.#active) this.next();
    }, 1500);
  }

  #draw(): void {
    if (!this.#renderer) return;
    const state: GameState = {
      boardId: this.#geo.id,
      board: this.#board,
      currentPlayer: 1,
      selectedCell: this.#selected,
      scores: { player1: 0, player2: 0 },
      status: 'playing',
      winner: null,
      turnNumber: this.#step + 1,
      lastMove: this.#lastMove,
      skippedPlayers: [],
    };
    const targets =
      this.#selected === null
        ? { clone: [], jump: [] }
        : getMoveTargets(this.#geo, this.#board, this.#selected, 1);
    this.#renderer.render(state, targets, { animateArrival: true });
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
