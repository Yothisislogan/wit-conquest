/**
 * Hex grid maths.
 *
 * Coordinate system: **axial** (`q`, `r`) over **flat-top** hexes.
 * The implicit third cube coordinate is `s = -q - r`.
 *
 * Flat-top rather than pointy-top for a mobile reason: a regular hexagonal
 * board drawn with pointy-top hexes is wider than it is tall, so on a portrait
 * phone it is width-bound and leaves a band of dead space above and below.
 * Turned on its side the same board is taller than wide, which is the shape a
 * phone actually has — the tiles come out roughly a quarter larger for exactly
 * the same layout.
 *
 * All game logic uses these coordinates. Pixel positions are derived *from*
 * coordinates and never the other way around — adjacency must never be inferred
 * from on-screen distance.
 */

import type { Axial } from './types.ts';

/**
 * The six axial neighbour offsets, listed clockwise starting at "south-east".
 * For flat-top hexes these correspond to: SE, NE, N, NW, SW, S.
 */
export const HEX_DIRECTIONS: readonly Axial[] = Object.freeze([
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]);

/** Human-readable names for the six directions, aligned with HEX_DIRECTIONS. */
export const HEX_DIRECTION_NAMES: readonly string[] = Object.freeze([
  'south-east',
  'north-east',
  'north',
  'north-west',
  'south-west',
  'south',
]);

/** Stable string key for a coordinate, used for map lookups. */
export function hexId(q: number, r: number): string {
  return `${q},${r}`;
}

export function axialEquals(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}

export function axialAdd(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function axialSubtract(a: Axial, b: Axial): Axial {
  return { q: a.q - b.q, r: a.r - b.r };
}

export function axialScale(a: Axial, factor: number): Axial {
  return { q: a.q * factor, r: a.r * factor };
}

/** Rotates a coordinate 180 degrees about the origin. Used for board symmetry. */
export function axialRotate180(a: Axial): Axial {
  return { q: -a.q, r: -a.r };
}

/**
 * Hex distance in steps. Equivalent to the cube-coordinate Chebyshev-style
 * metric `(|dq| + |dq + dr| + |dr|) / 2`.
 */
export function hexDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/** The six coordinates one step away. */
export function hexNeighbors(a: Axial): Axial[] {
  return HEX_DIRECTIONS.map((d) => axialAdd(a, d));
}

/**
 * The coordinates forming the ring at exactly `radius` steps from `center`.
 * Returns `[center]` for radius 0. Ring size is `6 * radius`.
 */
export function hexRing(center: Axial, radius: number): Axial[] {
  if (radius < 0) throw new RangeError(`hexRing radius must be >= 0, got ${radius}`);
  if (radius === 0) return [{ ...center }];

  const results: Axial[] = [];
  // Walk to the "south-west" corner of the ring, then trace each of the 6 edges.
  let current = axialAdd(center, axialScale(HEX_DIRECTIONS[4]!, radius));
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      results.push({ ...current });
      current = axialAdd(current, HEX_DIRECTIONS[side]!);
    }
  }
  return results;
}

/** Every coordinate within `radius` steps of `center`, including the centre. */
export function hexSpiral(center: Axial, radius: number): Axial[] {
  const results: Axial[] = [];
  for (let ring = 0; ring <= radius; ring++) {
    results.push(...hexRing(center, ring));
  }
  return results;
}

/**
 * Every coordinate of a regular hexagon of the given radius centred on the
 * origin, ordered top-to-bottom then left-to-right so that array indices read
 * naturally for accessibility labelling.
 */
export function hexagonShape(radius: number): Axial[] {
  const cells: Axial[] = [];
  for (let r = -radius; r <= radius; r++) {
    const qMin = Math.max(-radius, -r - radius);
    const qMax = Math.min(radius, -r + radius);
    for (let q = qMin; q <= qMax; q++) {
      cells.push({ q, r });
    }
  }
  return cells;
}

/**
 * Converts axial to "odd-q" offset coordinates: columns of hexes, with odd
 * columns pushed half a step down. Only used to derive the `row`/`column`
 * numbers that appear in screen-reader labels, where cells sharing a row read
 * as a near-horizontal band across the board.
 */
export function axialToOffset(a: Axial): { col: number; row: number } {
  return { col: a.q, row: a.r + (a.q - (a.q & 1)) / 2 };
}

/** Inverse of {@link axialToOffset}. */
export function offsetToAxial(col: number, row: number): Axial {
  return { q: col, r: row - (col - (col & 1)) / 2 };
}

/**
 * Centre point of a flat-top hex, in units where `size` is the distance from
 * the centre to a corner (the circumradius).
 */
export function axialToPixel(a: Axial, size: number): { x: number; y: number } {
  const SQRT3 = Math.sqrt(3);
  return {
    x: size * 1.5 * a.q,
    y: size * SQRT3 * (a.r + a.q / 2),
  };
}

/** The six corner points of a flat-top hex centred at (cx, cy). */
export function hexCorners(cx: number, cy: number, size: number): Array<{ x: number; y: number }> {
  const corners: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * 60 * i;
    corners.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return corners;
}

/** Serialises hex corners into an SVG `points` attribute. */
export function hexPolygonPoints(cx: number, cy: number, size: number, precision = 3): string {
  return hexCorners(cx, cy, size)
    .map((p) => `${p.x.toFixed(precision)},${p.y.toFixed(precision)}`)
    .join(' ');
}
