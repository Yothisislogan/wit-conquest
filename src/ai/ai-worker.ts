/// <reference lib="webworker" />
/**
 * Hosts the opponent search off the main thread so the board never freezes,
 * even when "Hard" is thinking on a slow phone.
 */

import { getBoard } from '../data/boards.ts';
import { chooseMove } from './ai-engine.ts';
import { createRandom, type AiRequestMessage, type AiWorkerMessage } from './types.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<AiRequestMessage>) => {
  const request = event.data;
  if (!request || request.kind !== 'ai-request') return;

  try {
    const geo = getBoard(request.boardId);
    const started = performance.now();
    const result = chooseMove(geo, request.board, request.player, request.difficulty, {
      timeLimitMs: request.timeLimitMs,
      random: createRandom(request.seed),
      now: () => performance.now(),
    });

    if (!result) {
      post({ kind: 'ai-error', id: request.id, message: 'no-legal-move' });
      return;
    }

    post({
      kind: 'ai-response',
      id: request.id,
      from: result.move.from,
      to: result.move.to,
      moveType: result.move.type,
      depth: result.depth,
      nodes: result.nodes,
      elapsedMs: result.elapsedMs || performance.now() - started,
      evaluation: result.evaluation,
    });
  } catch (error) {
    post({
      kind: 'ai-error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function post(message: AiWorkerMessage): void {
  ctx.postMessage(message);
}
