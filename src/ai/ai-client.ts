/**
 * Main-thread façade over the opponent.
 *
 * Prefers a Web Worker so the board keeps animating while the search runs, and
 * falls back to a synchronous call when workers are unavailable (older
 * browsers, some embedded webviews) or when the worker fails to start.
 */

import type { BoardGeometry } from '../game/board.ts';
import type { CellState, MoveOption, PlayerId } from '../game/types.ts';
import { chooseMove } from './ai-engine.ts';
import {
  createRandom,
  TIME_LIMITS,
  type AiRequestMessage,
  type AiWorkerMessage,
  type Difficulty,
} from './types.ts';

export interface AiDecision {
  move: MoveOption;
  depth: number;
  nodes: number;
  elapsedMs: number;
}

/** Coarse device check used only to pick a thinking budget. */
function isMobileLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function timeLimitFor(difficulty: Difficulty): number {
  const limits = TIME_LIMITS[difficulty];
  return isMobileLike() ? limits.mobile : limits.desktop;
}

export class AiClient {
  #worker: Worker | null = null;
  #workerBroken = false;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: AiDecision | null) => void; reject: (error: Error) => void; timer: number }
  >();

  /** Spins the worker up ahead of the first AI turn to hide startup cost. */
  warmUp(): void {
    this.#ensureWorker();
  }

  #ensureWorker(): Worker | null {
    if (this.#workerBroken) return null;
    if (this.#worker) return this.#worker;
    if (typeof Worker === 'undefined') {
      this.#workerBroken = true;
      return null;
    }

    try {
      const worker = new Worker(new URL('./ai-worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<AiWorkerMessage>) => {
        this.#settle(event.data);
      });
      worker.addEventListener('error', () => {
        // Reject everything in flight and never try the worker again this session.
        this.#workerBroken = true;
        for (const [id, entry] of this.#pending) {
          clearTimeout(entry.timer);
          this.#pending.delete(id);
          entry.reject(new Error('ai-worker-error'));
        }
        this.#worker?.terminate();
        this.#worker = null;
      });
      this.#worker = worker;
      return worker;
    } catch {
      this.#workerBroken = true;
      return null;
    }
  }

  #settle(message: AiWorkerMessage): void {
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(message.id);

    if (message.kind === 'ai-error') {
      if (message.message === 'no-legal-move') entry.resolve(null);
      else entry.reject(new Error(message.message));
      return;
    }

    entry.resolve({
      move: { from: message.from, to: message.to, type: message.moveType },
      depth: message.depth,
      nodes: message.nodes,
      elapsedMs: message.elapsedMs,
    });
  }

  /**
   * Chooses a move. Never rejects: any worker problem degrades to the
   * synchronous search on the main thread.
   */
  async decide(
    geo: BoardGeometry,
    board: readonly CellState[],
    player: PlayerId,
    difficulty: Difficulty,
    seed: number,
  ): Promise<AiDecision | null> {
    const timeLimitMs = timeLimitFor(difficulty);
    const worker = this.#ensureWorker();

    if (worker) {
      try {
        return await this.#decideInWorker(worker, geo, board, player, difficulty, seed, timeLimitMs);
      } catch {
        this.#workerBroken = true;
      }
    }

    return this.#decideInline(geo, board, player, difficulty, seed, timeLimitMs);
  }

  #decideInWorker(
    worker: Worker,
    geo: BoardGeometry,
    board: readonly CellState[],
    player: PlayerId,
    difficulty: Difficulty,
    seed: number,
    timeLimitMs: number,
  ): Promise<AiDecision | null> {
    const id = this.#nextId++;
    const request: AiRequestMessage = {
      kind: 'ai-request',
      id,
      boardId: geo.id,
      board: [...board],
      player,
      difficulty,
      timeLimitMs,
      seed,
    };

    return new Promise<AiDecision | null>((resolve, reject) => {
      // Generous watchdog: the search self-limits, so hitting this means the
      // worker itself is wedged and we should fall back.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('ai-worker-timeout'));
      }, timeLimitMs * 4 + 3_000) as unknown as number;

      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage(request);
    });
  }

  #decideInline(
    geo: BoardGeometry,
    board: readonly CellState[],
    player: PlayerId,
    difficulty: Difficulty,
    seed: number,
    timeLimitMs: number,
  ): AiDecision | null {
    const result = chooseMove(geo, board, player, difficulty, {
      timeLimitMs,
      random: createRandom(seed),
      now: () => performance.now(),
    });
    if (!result) return null;
    return { move: result.move, depth: result.depth, nodes: result.nodes, elapsedMs: result.elapsedMs };
  }

  dispose(): void {
    for (const [, entry] of this.#pending) clearTimeout(entry.timer);
    this.#pending.clear();
    this.#worker?.terminate();
    this.#worker = null;
  }
}
