/**
 * Iterative-deepening negamax with alpha-beta pruning.
 *
 * Design notes:
 *  - **Hard wall clock.** `timeLimitMs` is a budget the search must not blow,
 *    because it runs between the human's tap and the monster moving. Every
 *    iteration can be abandoned mid-flight; the deadline is checked on a node
 *    counter so the check itself never dominates the search.
 *  - **Never regress on abort.** An abandoned iteration is only allowed to
 *    change the answer when the previous best move was re-searched at the new
 *    depth first, which makes the comparison same-depth and therefore fair.
 *    Otherwise the last fully completed depth wins.
 *  - **One scratch board.** Moves are applied and undone in place on a private
 *    copy; the caller's array is never touched.
 */

import type { BoardGeometry } from '../game/board.ts';
import {
  applyMoveToBoard,
  countConversions,
  getLegalMoves,
  hasLegalMove,
  undoMoveOnBoard,
} from '../game/moves.ts';
import { computeScores } from '../game/scoring.ts';
import { opponentOf, type CellState, type MoveOption, type PlayerId } from '../game/types.ts';
import { centralityOf, evaluateBoard, type EvalWeights } from './evaluate-board.ts';
import type { AiResult } from './types.ts';

export interface SearchOptions {
  /** Hard wall-clock budget for the whole search, in milliseconds. */
  timeLimitMs: number;
  /** Injected RNG, used only to break exact ties in the root ordering. */
  random: () => number;
  /** Monotonic clock; defaults to `performance.now` (or `Date.now`). */
  now?: () => number;
  /** Deepest iteration the search may attempt. */
  maxDepth: number;
  weights: EvalWeights;
  /**
   * Width of the random tie-break applied to the initial root ordering, in
   * evaluation units. Because alpha-beta returns the true best score for a
   * completed iteration regardless of move order, this only ever decides
   * between moves that scored *identically* — it cannot select a worse move.
   */
  jitter?: number;
}

/** Any decisive result is worth more than any conceivable positional edge. */
export const WIN_SCORE = 1_000_000;
/** Scores at or beyond this are forced wins/losses, so searching deeper is pointless. */
const DECISIVE = WIN_SCORE / 2;
const INFINITY_SCORE = Number.POSITIVE_INFINITY;

/** Deepest ply the killer table covers. Search never comes close in practice. */
const MAX_PLY = 64;

/**
 * Nodes between deadline checks. A node costs a few microseconds, so 128 nodes
 * is well under a millisecond of overshoot while making the clock read itself
 * negligible.
 */
const TIME_CHECK_MASK = 127;

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

interface SearchContext {
  geo: BoardGeometry;
  /** Scratch board owned by the search. */
  board: CellState[];
  weights: EvalWeights;
  now: () => number;
  deadline: number;
  nodes: number;
  aborted: boolean;
  /** Two killer moves per ply: quiet-ish moves that caused a cutoff nearby. */
  killers: (MoveOption | null)[];
}

/**
 * Searches for the best move for `player`. Returns `null` only when `player`
 * has no legal move at all.
 */
export function searchBestMove(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  opts: SearchOptions,
): AiResult | null {
  const now = opts.now ?? defaultNow;
  const started = now();

  const rootMoves = getLegalMoves(geo, board, player);
  if (rootMoves.length === 0) return null;

  const ctx: SearchContext = {
    geo,
    board: [...board],
    weights: opts.weights,
    now,
    deadline: started + Math.max(1, opts.timeLimitMs),
    nodes: 0,
    aborted: false,
    killers: new Array<MoveOption | null>(MAX_PLY * 2).fill(null),
  };

  orderRootMoves(ctx, rootMoves, player, opts.random, opts.jitter ?? 0);

  const maxDepth = Math.max(1, Math.floor(opts.maxDepth));
  let best: MoveOption = rootMoves[0]!;
  let bestScore = 0;
  let completedDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -INFINITY_SCORE;
    let iterationBest: MoveOption | null = null;
    let iterationScore = -INFINITY_SCORE;
    let principalResearched = false;

    for (let i = 0; i < rootMoves.length; i++) {
      const move = rootMoves[i]!;
      const converted = applyMoveToBoard(geo, ctx.board, move, player);
      const score = -negamax(ctx, opponentOf(player), depth - 1, -INFINITY_SCORE, -alpha, 1);
      undoMoveOnBoard(ctx.board, move, player, converted);

      // The score of an aborted subtree is meaningless; drop it.
      if (ctx.aborted) break;

      if (i === 0) principalResearched = true;
      if (iterationBest === null || score > iterationScore) {
        iterationBest = move;
        iterationScore = score;
      }
      if (score > alpha) alpha = score;
    }

    if (!ctx.aborted && iterationBest !== null) {
      best = iterationBest;
      bestScore = iterationScore;
      completedDepth = depth;
      promoteToFront(rootMoves, best);
      // A forced win or loss will not change with more depth.
      if (Math.abs(bestScore) >= DECISIVE) break;
      // Each ply costs several times the last, so starting an iteration with
      // most of the budget already gone just throws the work away.
      if (now() - started > (ctx.deadline - started) * 0.45) break;
      continue;
    }

    // Aborted iteration. rootMoves[0] is the previous best, so if it was
    // re-searched at this depth every completed sibling was compared against it
    // on equal terms and the winner is a genuine improvement.
    if (principalResearched && iterationBest !== null) {
      best = iterationBest;
      bestScore = iterationScore;
    }
    break;
  }

  return {
    move: best,
    depth: completedDepth,
    nodes: ctx.nodes,
    elapsedMs: now() - started,
    evaluation: bestScore,
  };
}

function negamax(
  ctx: SearchContext,
  player: PlayerId,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
): number {
  ctx.nodes++;
  if ((ctx.nodes & TIME_CHECK_MASK) === 0 && ctx.now() >= ctx.deadline) {
    ctx.aborted = true;
    return alpha;
  }

  const scores = computeScores(ctx.board);
  const selfPieces = player === 1 ? scores.player1 : scores.player2;
  const foePieces = player === 1 ? scores.player2 : scores.player1;

  // Losing every piece ends the match immediately, whoever is to move.
  if (selfPieces === 0) return -decisiveScore(foePieces, ply);
  if (foePieces === 0) return decisiveScore(selfPieces, ply);

  if (depth <= 0) return evaluateBoard(ctx.geo, ctx.board, player, ctx.weights);

  const moves = getLegalMoves(ctx.geo, ctx.board, player);
  if (moves.length === 0) {
    const other = opponentOf(player);
    if (!hasLegalMove(ctx.geo, ctx.board, other)) {
      // Nobody can move: the match is over and piece count decides it.
      if (selfPieces === foePieces) return 0;
      const margin = Math.abs(selfPieces - foePieces);
      return selfPieces > foePieces ? decisiveScore(margin, ply) : -decisiveScore(margin, ply);
    }
    // Being skipped is not a loss — hand the turn straight back. Two skips in a
    // row are impossible (the branch above proves the opponent can move), so
    // this cannot recurse forever, and the depth still shrinks every ply.
    return -negamax(ctx, other, depth - 1, -beta, -alpha, ply + 1);
  }

  if (depth >= 2) orderMoves(ctx, moves, player, ply);

  let best = -INFINITY_SCORE;
  for (const move of moves) {
    const converted = applyMoveToBoard(ctx.geo, ctx.board, move, player);
    const score = -negamax(
      ctx,
      opponentOf(player),
      depth - 1,
      -beta,
      -Math.max(alpha, best),
      ply + 1,
    );
    undoMoveOnBoard(ctx.board, move, player, converted);

    if (ctx.aborted) return best > -INFINITY_SCORE ? best : alpha;
    if (score > best) best = score;
    if (best >= beta) {
      rememberKiller(ctx, move, ply);
      break;
    }
  }
  return best;
}

/**
 * Value of a decided position. Sooner is better, so deeper wins are discounted;
 * the margin is a tie-break between two wins found at the same depth.
 */
function decisiveScore(margin: number, ply: number): number {
  return WIN_SCORE - ply * 1_000 + margin;
}

/** Static ordering score: big flips first, then clones, then central landings. */
function moveHeuristic(ctx: SearchContext, move: MoveOption, player: PlayerId): number {
  const conversions = countConversions(ctx.geo, ctx.board, move.to, player);
  // Cloning keeps the origin, so it is worth a piece of its own.
  const shape = move.type === 'clone' ? 30 : 0;
  return conversions * 100 + shape + centralityOf(ctx.geo, move.to) * 10;
}

function orderMoves(ctx: SearchContext, moves: MoveOption[], player: PlayerId, ply: number): void {
  const slot = Math.min(ply, MAX_PLY - 1) * 2;
  const killerA = ctx.killers[slot] ?? null;
  const killerB = ctx.killers[slot + 1] ?? null;

  const scored = moves.map((move) => {
    let score = moveHeuristic(ctx, move, player);
    if (sameMove(move, killerA)) score += 80;
    else if (sameMove(move, killerB)) score += 60;
    return { move, score };
  });
  scored.sort((a, b) => b.score - a.score);
  for (let i = 0; i < scored.length; i++) moves[i] = scored[i]!.move;
}

/**
 * Root ordering. Identical to the in-tree ordering plus an optional random
 * tie-break, which is what gives the softer difficulties some variety without
 * ever downgrading their choice.
 */
function orderRootMoves(
  ctx: SearchContext,
  moves: MoveOption[],
  player: PlayerId,
  random: () => number,
  jitter: number,
): void {
  const scored = moves.map((move) => ({
    move,
    score: moveHeuristic(ctx, move, player) + (jitter > 0 ? (random() - 0.5) * jitter : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  for (let i = 0; i < scored.length; i++) moves[i] = scored[i]!.move;
}

function promoteToFront(moves: MoveOption[], move: MoveOption): void {
  const index = moves.findIndex((m) => sameMove(m, move));
  if (index <= 0) return;
  moves.splice(index, 1);
  moves.unshift(move);
}

function rememberKiller(ctx: SearchContext, move: MoveOption, ply: number): void {
  const slot = Math.min(ply, MAX_PLY - 1) * 2;
  if (sameMove(ctx.killers[slot] ?? null, move)) return;
  ctx.killers[slot + 1] = ctx.killers[slot] ?? null;
  ctx.killers[slot] = move;
}

function sameMove(a: MoveOption | null, b: MoveOption | null): boolean {
  return a !== null && b !== null && a.from === b.from && a.to === b.to && a.type === b.type;
}
