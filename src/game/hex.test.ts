import { describe, expect, it } from 'vitest';
import {
  axialToOffset,
  axialToPixel,
  axialRotate180,
  hexDistance,
  hexNeighbors,
  hexPolygonPoints,
  hexRing,
  hexSpiral,
  hexagonShape,
  offsetToAxial,
  HEX_DIRECTIONS,
} from './hex.ts';

describe('hex coordinates', () => {
  it('gives every cell exactly six neighbours at distance one', () => {
    const neighbours = hexNeighbors({ q: 2, r: -3 });
    expect(neighbours).toHaveLength(6);
    expect(new Set(neighbours.map((n) => `${n.q},${n.r}`)).size).toBe(6);
    for (const n of neighbours) {
      expect(hexDistance({ q: 2, r: -3 }, n)).toBe(1);
    }
  });

  it('measures distance symmetrically and satisfies the triangle inequality', () => {
    const a = { q: -3, r: 1 };
    const b = { q: 2, r: -4 };
    const c = { q: 0, r: 0 };
    expect(hexDistance(a, b)).toBe(hexDistance(b, a));
    expect(hexDistance(a, a)).toBe(0);
    expect(hexDistance(a, b)).toBeLessThanOrEqual(hexDistance(a, c) + hexDistance(c, b));
  });

  it('builds rings of the expected size, all at the ring radius', () => {
    for (let radius = 1; radius <= 4; radius++) {
      const ring = hexRing({ q: 0, r: 0 }, radius);
      expect(ring).toHaveLength(6 * radius);
      expect(new Set(ring.map((c) => `${c.q},${c.r}`)).size).toBe(6 * radius);
      for (const cell of ring) expect(hexDistance({ q: 0, r: 0 }, cell)).toBe(radius);
    }
  });

  it('treats radius zero as the centre itself', () => {
    expect(hexRing({ q: 4, r: -1 }, 0)).toEqual([{ q: 4, r: -1 }]);
  });

  it('produces 12 jump destinations at distance two', () => {
    const ring = hexRing({ q: 0, r: 0 }, 2);
    expect(ring).toHaveLength(12);
  });

  it('fills a hexagon with 3r(r+1)+1 cells', () => {
    for (let radius = 0; radius <= 5; radius++) {
      expect(hexagonShape(radius)).toHaveLength(3 * radius * (radius + 1) + 1);
    }
    // The shipped boards use radius 4.
    expect(hexagonShape(4)).toHaveLength(61);
  });

  it('matches the spiral of rings', () => {
    const shape = new Set(hexagonShape(3).map((c) => `${c.q},${c.r}`));
    const spiral = new Set(hexSpiral({ q: 0, r: 0 }, 3).map((c) => `${c.q},${c.r}`));
    expect(spiral).toEqual(shape);
  });

  it('round-trips axial and odd-r offset coordinates, including negatives', () => {
    for (let q = -6; q <= 6; q++) {
      for (let r = -6; r <= 6; r++) {
        const offset = axialToOffset({ q, r });
        expect(offsetToAxial(offset.col, offset.row)).toEqual({ q, r });
      }
    }
  });

  it('rotates 180 degrees as an involution that preserves distance', () => {
    const a = { q: 3, r: -1 };
    expect(axialRotate180(axialRotate180(a))).toEqual(a);
    expect(hexDistance({ q: 0, r: 0 }, a)).toBe(hexDistance({ q: 0, r: 0 }, axialRotate180(a)));
  });

  it('places neighbouring pixels exactly one hex width apart', () => {
    const origin = axialToPixel({ q: 0, r: 0 }, 1);
    for (const direction of HEX_DIRECTIONS) {
      const point = axialToPixel(direction, 1);
      const gap = Math.hypot(point.x - origin.x, point.y - origin.y);
      // Centre-to-centre distance for a hex of circumradius 1 is sqrt(3).
      expect(gap).toBeCloseTo(Math.sqrt(3), 10);
    }
  });

  it('emits six polygon corners', () => {
    const points = hexPolygonPoints(0, 0, 1).split(' ');
    expect(points).toHaveLength(6);
    for (const point of points) {
      const [x, y] = point.split(',').map(Number);
      expect(Math.hypot(x!, y!)).toBeCloseTo(1, 2);
    }
  });
});
