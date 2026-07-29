/**
 * Static position evaluation.
 *
 * The score is always expressed from the point of view of the player passed in,
 * and every term is a *difference* between that player's metric and the
 * opponent's. That makes the function exactly antisymmetric — evaluating the
 * same board for the other player returns the negation — which is what a
 * negamax search assumes, and which keeps the weights honest: no term can
 * accidentally reward a side just for existing.
 *
 * Terms, and why each one is here:
 *  - material            pieces on the board decide the match.
 *  - bestConversion      the biggest flip currently available; a landing next to
 *                        three enemies is worth six pieces of swing.
 *  - threatCount         how many *different* destinations flip something, i.e.
 *                        how hard the threat is to answer with one move.
 *  - mobility            spaces you can land on at all; running out of moves
 *                        means being skipped.
 *  - cloneAccess         spaces reachable by cloning. Clones are strictly better
 *                        than jumps because they do not vacate the origin.
 *  - centrality          central spaces touch more of the board.
 *  - safety              spaces with few open neighbours are hard to flip.
 *  - vulnerability       own pieces standing next to an empty space the
 *                        opponent can land on (subtracted).
 */

import type { BoardGeometry } from '../game/board.ts';
import { cellStateFor, opponentOf, type CellState, type PlayerId } from '../game/types.ts';
import type { Difficulty } from './types.ts';

export interface EvalWeights {
  /** Weight of the raw piece-count difference. */
  material: number;
  /** Additional material weight, ramped in as the board fills up. */
  materialEndgame: number;
  /** Weight of the largest conversion available to each side. */
  bestConversion: number;
  /** Weight of the number of distinct converting destinations. */
  threatCount: number;
  /** Weight of the landable-space count (clone or jump). */
  mobility: number;
  /** Weight of the clone-reachable space count. */
  cloneAccess: number;
  /** Weight of centrality-weighted piece placement. */
  centrality: number;
  /** Weight of pieces standing on hard-to-flip spaces. */
  safety: number;
  /** Penalty weight for own pieces the opponent could flip on the reply. */
  vulnerability: number;
}

/**
 * Per-difficulty weight sets. Material dominates everywhere — converting one
 * piece is a two-piece swing, so a single conversion outweighs the whole
 * positional package — but the easier opponents look at less of the board, and
 * in particular care far less about what the reply does to them.
 */
export const WEIGHTS: Record<Difficulty, EvalWeights> = Object.freeze({
  easy: {
    material: 100,
    materialEndgame: 0,
    bestConversion: 8,
    threatCount: 0,
    mobility: 0,
    cloneAccess: 1,
    centrality: 2,
    safety: 0,
    vulnerability: 0,
  },
  normal: {
    material: 100,
    materialEndgame: 40,
    bestConversion: 20,
    threatCount: 4,
    mobility: 2,
    cloneAccess: 4,
    centrality: 6,
    safety: 4,
    vulnerability: 7,
  },
  hard: {
    material: 100,
    materialEndgame: 60,
    bestConversion: 26,
    threatCount: 5,
    mobility: 3,
    cloneAccess: 6,
    centrality: 9,
    safety: 7,
    vulnerability: 10,
  },
});

/** Board-static data derived once per geometry. */
interface BoardStatics {
  /** 1 at the middle of the board, 0 at the rim. */
  centrality: Float64Array;
  /** 1 when a space is almost impossible to be flipped on, 0 in the open. */
  safety: Float64Array;
  /**
   * Scratch flags reused between evaluations of the same geometry: bit 0 marks
   * "the evaluating player can land here", bit 1 marks "the opponent can".
   * Every empty space is rewritten on each call before it is read, and only
   * empty spaces are ever read, so stale entries can never leak between calls.
   * The search is single-threaded, so sharing one buffer is safe and saves an
   * allocation per evaluated node.
   */
  landing: Uint8Array;
}

const LAND_SELF = 1;
const LAND_OPPONENT = 2;

// Keyed on the geometry object so unused boards can be collected, and so tests
// that compile a throwaway board do not grow a permanent cache.
const STATICS = new WeakMap<BoardGeometry, BoardStatics>();

function staticsFor(geo: BoardGeometry): BoardStatics {
  const cached = STATICS.get(geo);
  if (cached) return cached;

  const count = geo.cells.length;
  const centrality = new Float64Array(count);
  const safety = new Float64Array(count);

  // Ring distance from the axial origin: the boards are centred hexagons, so
  // this is the natural "how far out is this space" measure.
  const ringDistance = geo.cells.map((c) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2);
  const maxRing = Math.max(1, ...ringDistance);

  for (let i = 0; i < count; i++) {
    centrality[i] = 1 - ringDistance[i]! / maxRing;
    // Only spaces that can actually hold a piece can be used as a landing pad
    // by an attacker, so obstacles and the board edge both count as cover.
    let open = 0;
    for (const n of geo.neighbors[i]!) {
      if (!geo.cells[n]!.blocked) open++;
    }
    safety[i] = (6 - open) / 6;
  }

  const statics: BoardStatics = { centrality, safety, landing: new Uint8Array(count) };
  STATICS.set(geo, statics);
  return statics;
}

/** Centrality of a space, 1 in the middle and 0 at the rim. Used for move ordering. */
export function centralityOf(geo: BoardGeometry, index: number): number {
  return staticsFor(geo).centrality[index]!;
}

/**
 * Scores `board` from `player`'s point of view. Higher is better for `player`.
 * Pure with respect to the caller: `board` is only read.
 */
export function evaluateBoard(
  geo: BoardGeometry,
  board: readonly CellState[],
  player: PlayerId,
  weights: EvalWeights,
): number {
  const { centrality, safety, landing } = staticsFor(geo);
  const self = cellStateFor(player);
  const foe = cellStateFor(opponentOf(player));
  const size = board.length;

  let selfPieces = 0;
  let foePieces = 0;
  let empties = 0;
  let selfCentre = 0;
  let foeCentre = 0;
  let selfSafe = 0;
  let foeSafe = 0;
  let selfMobility = 0;
  let foeMobility = 0;
  let selfClones = 0;
  let foeClones = 0;
  let selfThreats = 0;
  let foeThreats = 0;
  let selfBest = 0;
  let foeBest = 0;

  // Pass 1: piece bookkeeping, plus everything that can be learned by looking
  // at an empty space and its surroundings.
  for (let i = 0; i < size; i++) {
    const state = board[i]!;
    if (state === 'blocked') continue;

    if (state === self) {
      selfPieces++;
      selfCentre += centrality[i]!;
      selfSafe += safety[i]!;
      continue;
    }
    if (state === foe) {
      foePieces++;
      foeCentre += centrality[i]!;
      foeSafe += safety[i]!;
      continue;
    }

    empties++;
    let selfAdjacent = 0;
    let foeAdjacent = 0;
    for (const n of geo.neighbors[i]!) {
      const neighbour = board[n]!;
      if (neighbour === self) selfAdjacent++;
      else if (neighbour === foe) foeAdjacent++;
    }

    // Reachability is symmetric: `i` is a jump target of `n` exactly when `n`
    // is a jump target of `i`, so looking outwards from the empty space finds
    // every piece that could land on it.
    let selfCanLand = selfAdjacent > 0;
    let foeCanLand = foeAdjacent > 0;
    if (!selfCanLand || !foeCanLand) {
      for (const n of geo.jumpTargets[i]!) {
        const neighbour = board[n]!;
        if (neighbour === self) selfCanLand = true;
        else if (neighbour === foe) foeCanLand = true;
        if (selfCanLand && foeCanLand) break;
      }
    }

    landing[i] = (selfCanLand ? LAND_SELF : 0) | (foeCanLand ? LAND_OPPONENT : 0);

    if (selfCanLand) {
      selfMobility++;
      if (selfAdjacent > 0) selfClones++;
      if (foeAdjacent > 0) {
        selfThreats++;
        if (foeAdjacent > selfBest) selfBest = foeAdjacent;
      }
    }
    if (foeCanLand) {
      foeMobility++;
      if (foeAdjacent > 0) foeClones++;
      if (selfAdjacent > 0) {
        foeThreats++;
        if (selfAdjacent > foeBest) foeBest = selfAdjacent;
      }
    }
  }

  // Pass 2: exposure. A piece is exposed when it sits next to an empty space
  // the other side can drop onto — that is exactly the set of pieces that could
  // be flipped on the reply. Needs the completed landing map from pass 1.
  let selfExposed = 0;
  let foeExposed = 0;
  for (let i = 0; i < size; i++) {
    const state = board[i]!;
    if (state !== self && state !== foe) continue;
    const attacker = state === self ? LAND_OPPONENT : LAND_SELF;
    for (const n of geo.neighbors[i]!) {
      if (board[n] === 'empty' && (landing[n]! & attacker) !== 0) {
        if (state === self) selfExposed++;
        else foeExposed++;
        break;
      }
    }
  }

  // Material matters more the closer the board is to full, because there is
  // less time left to win it back.
  const fill = geo.playableCount > 0 ? 1 - empties / geo.playableCount : 1;
  const materialWeight = weights.material + weights.materialEndgame * fill;

  return (
    materialWeight * (selfPieces - foePieces) +
    weights.bestConversion * (selfBest - foeBest) +
    weights.threatCount * (selfThreats - foeThreats) +
    weights.mobility * (selfMobility - foeMobility) +
    weights.cloneAccess * (selfClones - foeClones) +
    weights.centrality * (selfCentre - foeCentre) +
    weights.safety * (selfSafe - foeSafe) -
    weights.vulnerability * (selfExposed - foeExposed)
  );
}
