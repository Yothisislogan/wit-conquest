/**
 * Hex grid maths.
 *
 * Coordinate system: **axial** (`q`, `r`) over **pointy-top** hexes.
 * The implicit third cube coordinate is `s = -q - r`.
 *
 * All game logic uses these coordinates. Pixel positions are derived *from*
 * coordinates and never the other way around — adjacency must never be inferred
 * from on-screen distance.
 */

import type { Axial } from './types.ts';

/**
 * The six axial neighbour offsets, listed clockwise starting at "east".
 * For pointy-top hexes these correspond to: E, NE, NW, W, SW, SE.
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
  'east',
  'north-east',
  'north-west',
  'west',
  'south-west',
  'south-east',
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
 * Converts axial to "odd-r" offset coordinates (rows of hexes, odd rows shifted
 * right). Only used to produce `row`/`column` labels for screen readers.
 */
export function axialToOffset(a: Axial): { col: number; row: number } {
  return { col: a.q + (a.r - (a.r & 1)) / 2, row: a.r };
}

/** Inverse of {@link axialToOffset}. */
export function offsetToAxial(col: number, row: number): Axial {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

/**
 * Centre point of a pointy-top hex, in units where `size` is the distance from
 * the centre to a corner (the circumradius).
 */
export function axialToPixel(a: Axial, size: number): { x: number; y: number } {
  const SQRT3 = Math.sqrt(3);
  return {
    x: size * SQRT3 * (a.q + a.r / 2),
    y: size * 1.5 * a.r,
  };
}

/** The six corner points of a pointy-top hex centred at (cx, cy). */
export function hexCorners(cx: number, cy: number, size: number): Array<{ x: number; y: number }> {
  const corners: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
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
