/**
 * Contract shared by every opponent implementation and by the Web Worker that
 * hosts them. Kept free of DOM references so the search can run in a worker.
 */

import type { BoardGeometry } from '../game/board.ts';
import type { CellState, MoveOption, PlayerId } from '../game/types.ts';

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTIES: readonly Difficulty[] = Object.freeze(['easy', 'normal', 'hard']);

export interface AiOptions {
  /**
   * Wall-clock budget for the whole decision. Implementations must return
   * within this budget; the search is iterative-deepening for that reason.
   */
  timeLimitMs: number;
  /** Injected RNG so tests are deterministic. Returns [0, 1). */
  random: () => number;
  /** Monotonic clock, injectable for tests. */
  now?: () => number;
}

export interface AiResult {
  move: MoveOption;
  /** Plies actually searched (0 for the purely heuristic opponents). */
  depth: number;
  /** Positions evaluated, for diagnostics. */
  nodes: number;
  elapsedMs: number;
  /** Evaluation of the chosen line, from the moving player's point of view. */
  evaluation: number;
}

/** Signature every difficulty module exports. */
export type MoveChooser = (
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  options: AiOptions,
) => AiResult | null;

/** Default per-move thinking budgets, in milliseconds. */
export const TIME_LIMITS: Record<Difficulty, { mobile: number; desktop: number }> = {
  easy: { mobile: 220, desktop: 220 },
  normal: { mobile: 500, desktop: 650 },
  hard: { mobile: 1_100, desktop: 1_500 },
};

/** Minimum delay before an AI move is played, so turns never feel instant. */
export const MIN_THINKING_MS = 260;

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

export interface AiRequestMessage {
  kind: 'ai-request';
  id: number;
  boardId: string;
  board: CellState[];
  player: PlayerId;
  difficulty: Difficulty;
  timeLimitMs: number;
  /** Seed for the worker's deterministic RNG. */
  seed: number;
}

export interface AiResponseMessage {
  kind: 'ai-response';
  id: number;
  from: number;
  to: number;
  moveType: MoveOption['type'];
  depth: number;
  nodes: number;
  elapsedMs: number;
  evaluation: number;
}

export interface AiErrorMessage {
  kind: 'ai-error';
  id: number;
  message: string;
}

export type AiWorkerMessage = AiResponseMessage | AiErrorMessage;

/**
 * Small, fast, seedable RNG (mulberry32). Deterministic across platforms so
 * replaying a seed reproduces an opponent's choices exactly.
 */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
