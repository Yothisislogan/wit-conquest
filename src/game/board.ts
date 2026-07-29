/**
 * Board compilation: turns a declarative {@link BoardDefinition} into a
 * {@link BoardGeometry} with pre-computed adjacency and jump tables.
 *
 * Compiling once at load time means move generation is pure array lookups,
 * which matters for the minimax search on the "Hard" opponent.
 */

import {
  axialRotate180,
  axialToOffset,
  axialToPixel,
  hexDistance,
  hexId,
  hexRing,
  hexagonShape,
} from './hex.ts';
import type { Axial, CellState, HexCell } from './types.ts';

/** Distance (in hex steps) of a clone move. */
export const CLONE_DISTANCE = 1;
/** Distance (in hex steps) of a jump move. */
export const JUMP_DISTANCE = 2;

export interface BoardDefinition {
  id: string;
  name: string;
  /** One-line description shown in the board picker. */
  description: string;
  /** Longer blurb describing the strategic character of the layout. */
  strategy: string;
  /** Radius of the enclosing regular hexagon. Radius 4 yields 61 spaces. */
  radius: number;
  /**
   * Coordinates that are carved out of the hexagon entirely (they are not part
   * of the board at all, as opposed to being blocked obstacles on it).
   */
  removed?: Axial[];
  /** Obstacle spaces: part of the board, but never playable. */
  blocked: Axial[];
  /** Starting pieces for player 1. Player 2's are the 180° rotation of these. */
  starts: Axial[];
}

export interface BoardGeometry {
  id: string;
  name: string;
  description: string;
  strategy: string;
  cells: HexCell[];
  /** `"q,r"` → index into `cells`. */
  indexById: Map<string, number>;
  /** index → indices of the (up to 6) spaces exactly one step away. */
  neighbors: number[][];
  /** index → indices of the (up to 12) spaces exactly two steps away. */
  jumpTargets: number[][];
  /** The board as it looks before the first move. */
  initialBoard: CellState[];
  /** Number of spaces that can ever hold a piece. */
  playableCount: number;
  /** Number of label rows. */
  rowCount: number;
  /** Indices grouped by label row, ordered left to right. */
  rowIndices: number[][];
  /** Bounding box in board units for a hex circumradius of 1. */
  bounds: { minX: number; minY: number; width: number; height: number };
}

/**
 * Returns `cells` together with their 180° rotations, de-duplicated.
 * Authoring obstacle sets through this helper makes every board rotationally
 * symmetric by construction rather than by review.
 */
export function symmetricPairs(cells: Axial[]): Axial[] {
  const seen = new Map<string, Axial>();
  for (const cell of cells) {
    const mirrored = axialRotate180(cell);
    seen.set(hexId(cell.q, cell.r), cell);
    seen.set(hexId(mirrored.q, mirrored.r), mirrored);
  }
  return [...seen.values()];
}

/** Compiles a definition into the lookup tables the engine and renderer use. */
export function compileBoard(def: BoardDefinition): BoardGeometry {
  const removed = new Set((def.removed ?? []).map((c) => hexId(c.q, c.r)));
  const shape = hexagonShape(def.radius).filter((c) => !removed.has(hexId(c.q, c.r)));

  const blocked = new Set(def.blocked.map((c) => hexId(c.q, c.r)));
  for (const id of blocked) {
    if (removed.has(id)) {
      throw new Error(`Board "${def.id}": ${id} is both removed and blocked.`);
    }
  }

  // Group into near-horizontal bands (offset rows), then order left to right,
  // so "row 3, column 4" reads the way a sighted player would scan the board.
  const byRow = new Map<number, Axial[]>();
  for (const cell of shape) {
    const { row } = axialToOffset(cell);
    const bucket = byRow.get(row);
    if (bucket) bucket.push(cell);
    else byRow.set(row, [cell]);
  }
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of sortedRows) {
    byRow.get(row)!.sort((a, b) => axialToOffset(a).col - axialToOffset(b).col);
  }

  const cells: HexCell[] = [];
  const rowIndices: number[][] = [];
  for (let rowIdx = 0; rowIdx < sortedRows.length; rowIdx++) {
    const rowCells = byRow.get(sortedRows[rowIdx]!)!;
    const indices: number[] = [];
    for (let colIdx = 0; colIdx < rowCells.length; colIdx++) {
      const { q, r } = rowCells[colIdx]!;
      const { x, y } = axialToPixel({ q, r }, 1);
      const index = cells.length;
      cells.push({
        id: hexId(q, r),
        index,
        q,
        r,
        row: rowIdx + 1,
        col: colIdx + 1,
        x,
        y,
        blocked: blocked.has(hexId(q, r)),
      });
      indices.push(index);
    }
    rowIndices.push(indices);
  }

  const indexById = new Map<string, number>();
  for (const cell of cells) indexById.set(cell.id, cell.index);

  const neighbors: number[][] = cells.map((cell) =>
    hexRing({ q: cell.q, r: cell.r }, CLONE_DISTANCE)
      .map((n) => indexById.get(hexId(n.q, n.r)))
      .filter((i): i is number => i !== undefined),
  );

  const jumpTargets: number[][] = cells.map((cell) =>
    hexRing({ q: cell.q, r: cell.r }, JUMP_DISTANCE)
      .map((n) => indexById.get(hexId(n.q, n.r)))
      .filter((i): i is number => i !== undefined),
  );

  const initialBoard: CellState[] = cells.map((cell) => (cell.blocked ? 'blocked' : 'empty'));

  for (const start of def.starts) {
    const p1 = indexById.get(hexId(start.q, start.r));
    const mirrored = axialRotate180(start);
    const p2 = indexById.get(hexId(mirrored.q, mirrored.r));
    if (p1 === undefined || p2 === undefined) {
      throw new Error(`Board "${def.id}": start ${hexId(start.q, start.r)} is not on the board.`);
    }
    if (initialBoard[p1] !== 'empty' || initialBoard[p2] !== 'empty') {
      throw new Error(`Board "${def.id}": start ${hexId(start.q, start.r)} overlaps a blocked or duplicate space.`);
    }
    initialBoard[p1] = 'player1';
    initialBoard[p2] = 'player2';
  }

  // Flat-top hexes reach `size` horizontally (centre to corner) and
  // `sqrt(3)/2 * size` vertically (centre to edge).
  const size = 1;
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const halfHeight = (Math.sqrt(3) / 2) * size;
  const minX = Math.min(...xs) - size;
  const maxX = Math.max(...xs) + size;
  const minY = Math.min(...ys) - halfHeight;
  const maxY = Math.max(...ys) + halfHeight;

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    strategy: def.strategy,
    cells,
    indexById,
    neighbors,
    jumpTargets,
    initialBoard,
    playableCount: initialBoard.filter((s) => s !== 'blocked').length,
    rowCount: rowIndices.length,
    rowIndices,
    bounds: { minX, minY, width: maxX - minX, height: maxY - minY },
  };
}

export interface BoardValidationIssue {
  code:
    | 'not-symmetric'
    | 'playable-count'
    | 'start-overlap'
    | 'start-not-symmetric'
    | 'unreachable'
    | 'no-opening-move';
  message: string;
}

/**
 * Structural checks every shipped layout must pass. Run by the unit tests so a
 * badly authored board can never reach players.
 */
export function validateBoard(geo: BoardGeometry): BoardValidationIssue[] {
  const issues: BoardValidationIssue[] = [];

  // 1. The set of spaces and their blocked-ness must survive a 180° rotation.
  for (const cell of geo.cells) {
    const mirrored = axialRotate180({ q: cell.q, r: cell.r });
    const mirrorIndex = geo.indexById.get(hexId(mirrored.q, mirrored.r));
    if (mirrorIndex === undefined) {
      issues.push({
        code: 'not-symmetric',
        message: `${geo.id}: ${cell.id} has no 180° counterpart.`,
      });
      continue;
    }
    if (geo.cells[mirrorIndex]!.blocked !== cell.blocked) {
      issues.push({
        code: 'not-symmetric',
        message: `${geo.id}: ${cell.id} and its counterpart disagree on blocked state.`,
      });
    }
  }

  // 2. Playable space count stays inside the design target.
  if (geo.playableCount < 45 || geo.playableCount > 65) {
    issues.push({
      code: 'playable-count',
      message: `${geo.id}: ${geo.playableCount} playable spaces, expected 45-65.`,
    });
  }

  // 3. Starting positions mirror each other exactly and never overlap.
  const p1 = geo.initialBoard.flatMap((s, i) => (s === 'player1' ? [i] : []));
  const p2 = geo.initialBoard.flatMap((s, i) => (s === 'player2' ? [i] : []));
  if (p1.length !== p2.length || p1.length === 0) {
    issues.push({
      code: 'start-overlap',
      message: `${geo.id}: uneven starting pieces (${p1.length} vs ${p2.length}).`,
    });
  }
  for (const index of p1) {
    const cell = geo.cells[index]!;
    const mirrored = axialRotate180({ q: cell.q, r: cell.r });
    const mirrorIndex = geo.indexById.get(hexId(mirrored.q, mirrored.r));
    if (mirrorIndex === undefined || geo.initialBoard[mirrorIndex] !== 'player2') {
      issues.push({
        code: 'start-not-symmetric',
        message: `${geo.id}: player 1 start ${cell.id} has no mirrored player 2 start.`,
      });
    }
  }

  // 4. Every playable space must be reachable through clone+jump connectivity,
  //    otherwise part of the board is decorative.
  const reachable = reachableSpaces(geo);
  const playableIndices = geo.cells.filter((c) => !c.blocked).map((c) => c.index);
  for (const index of playableIndices) {
    if (!reachable.has(index)) {
      issues.push({
        code: 'unreachable',
        message: `${geo.id}: ${geo.cells[index]!.id} can never be occupied.`,
      });
    }
  }

  // 5. Both players must have at least one legal opening move.
  for (const player of [1, 2] as const) {
    const owner = player === 1 ? 'player1' : 'player2';
    const hasMove = geo.initialBoard.some((state, index) => {
      if (state !== owner) return false;
      return [...geo.neighbors[index]!, ...geo.jumpTargets[index]!].some(
        (t) => geo.initialBoard[t] === 'empty',
      );
    });
    if (!hasMove) {
      issues.push({
        code: 'no-opening-move',
        message: `${geo.id}: player ${player} has no opening move.`,
      });
    }
  }

  return issues;
}

/**
 * Flood fill from the starting pieces across clone and jump links, ignoring
 * occupancy. Any playable space not reached is unreachable for both players.
 */
function reachableSpaces(geo: BoardGeometry): Set<number> {
  const seen = new Set<number>();
  const queue: number[] = [];
  geo.initialBoard.forEach((state, index) => {
    if (state === 'player1' || state === 'player2') {
      seen.add(index);
      queue.push(index);
    }
  });

  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const next of [...geo.neighbors[index]!, ...geo.jumpTargets[index]!]) {
      if (seen.has(next) || geo.cells[next]!.blocked) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** Hex-step distance between two board indices. */
export function distanceBetween(geo: BoardGeometry, a: number, b: number): number {
  const from = geo.cells[a]!;
  const to = geo.cells[b]!;
  return hexDistance({ q: from.q, r: from.r }, { q: to.q, r: to.r });
}
