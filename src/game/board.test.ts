import { describe, expect, it } from 'vitest';
import {
  compileBoard,
  distanceBetween,
  symmetricPairs,
  validateBoard,
  type BoardDefinition,
} from './board.ts';
import { BOARD_DEFINITIONS, getAllBoards, getBoard, getTutorialBoard, resolveBoardId } from '../data/boards.ts';
import { hexId } from './hex.ts';

describe('board compilation', () => {
  it('numbers rows top to bottom and columns left to right', () => {
    const geo = getBoard('classic');
    expect(geo.rowCount).toBe(9);
    for (let row = 0; row < geo.rowIndices.length; row++) {
      const indices = geo.rowIndices[row]!;
      for (let col = 0; col < indices.length; col++) {
        const cell = geo.cells[indices[col]!]!;
        expect(cell.row).toBe(row + 1);
        expect(cell.col).toBe(col + 1);
      }
      // Left to right means strictly increasing x within a row.
      const xs = indices.map((i) => geo.cells[i]!.x);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    }
  });

  it('builds adjacency from coordinates, not pixels', () => {
    const geo = getBoard('classic');
    for (const cell of geo.cells) {
      for (const neighbour of geo.neighbors[cell.index]!) {
        expect(distanceBetween(geo, cell.index, neighbour)).toBe(1);
      }
      for (const target of geo.jumpTargets[cell.index]!) {
        expect(distanceBetween(geo, cell.index, target)).toBe(2);
      }
      expect(geo.neighbors[cell.index]!.length).toBeLessThanOrEqual(6);
      expect(geo.jumpTargets[cell.index]!.length).toBeLessThanOrEqual(12);
      // Adjacency is mutual.
      for (const neighbour of geo.neighbors[cell.index]!) {
        expect(geo.neighbors[neighbour]).toContain(cell.index);
      }
    }
  });

  it('treats obstacles as part of the grid but never as playable', () => {
    const geo = getBoard('crossroads');
    const blocked = geo.cells.filter((c) => c.blocked);
    expect(blocked.length).toBeGreaterThan(0);
    for (const cell of blocked) {
      expect(geo.initialBoard[cell.index]).toBe('blocked');
      // Obstacles still take part in adjacency so jumps can fly over them.
      expect(geo.neighbors[cell.index]!.length).toBeGreaterThan(0);
    }
    expect(geo.playableCount).toBe(geo.cells.length - blocked.length);
  });

  it('rejects a start position that is not on the board', () => {
    const bad: BoardDefinition = {
      id: 'bad',
      name: 'bad',
      description: '',
      strategy: '',
      radius: 2,
      blocked: [],
      starts: [{ q: 9, r: 9 }],
    };
    expect(() => compileBoard(bad)).toThrow(/not on the board/);
  });

  it('rejects a start position that lands on an obstacle', () => {
    const bad: BoardDefinition = {
      id: 'bad',
      name: 'bad',
      description: '',
      strategy: '',
      radius: 2,
      blocked: symmetricPairs([{ q: 2, r: 0 }]),
      starts: [{ q: 2, r: 0 }],
    };
    expect(() => compileBoard(bad)).toThrow(/blocked or duplicate/);
  });

  it('memoises compiled layouts', () => {
    expect(getBoard('classic')).toBe(getBoard('classic'));
    expect(getTutorialBoard()).toBe(getTutorialBoard());
  });

  it('falls back to the default layout for an unknown id', () => {
    expect(resolveBoardId('nope')).toBe('classic');
    expect(resolveBoardId(null)).toBe('classic');
    expect(resolveBoardId('islands')).toBe('islands');
    expect(resolveBoardId('tutorial')).toBe('classic');
    expect(() => getBoard('nope')).toThrow(/Unknown board/);
  });
});

describe('symmetricPairs', () => {
  it('adds the 180 degree rotation of every coordinate exactly once', () => {
    const pairs = symmetricPairs([
      { q: 2, r: 0 },
      { q: 0, r: -2 },
    ]);
    const ids = pairs.map((c) => hexId(c.q, c.r)).sort();
    expect(ids).toEqual(['-2,0', '0,-2', '0,2', '2,0'].sort());
  });

  it('is idempotent and keeps the origin single', () => {
    const once = symmetricPairs([{ q: 0, r: 0 }]);
    expect(once).toHaveLength(1);
    expect(symmetricPairs(once)).toHaveLength(1);
  });
});

describe('shipped layouts', () => {
  it('passes every structural rule', () => {
    for (const layout of getAllBoards()) {
      expect(validateBoard(layout), `${layout.id} issues`).toEqual([]);
    }
  });

  it('is exactly 180 degree rotationally symmetric, obstacles included', () => {
    for (const layout of getAllBoards()) {
      for (const cell of layout.cells) {
        const mirror = layout.indexById.get(hexId(-cell.q, -cell.r));
        expect(mirror, `${layout.id}: mirror of ${cell.id}`).toBeDefined();
        const other = layout.cells[mirror!]!;
        expect(other.blocked).toBe(cell.blocked);

        const a = layout.initialBoard[cell.index];
        const b = layout.initialBoard[other.index];
        // A player 1 start must mirror onto a player 2 start and vice versa.
        if (a === 'player1') expect(b).toBe('player2');
        if (a === 'player2') expect(b).toBe('player1');
        if (a === 'empty') expect(b).toBe('empty');
      }
    }
  });

  it('gives each side the same number, shape and reach of starting monsters', () => {
    for (const layout of getAllBoards()) {
      const p1 = layout.initialBoard.filter((s) => s === 'player1').length;
      const p2 = layout.initialBoard.filter((s) => s === 'player2').length;
      expect(p1).toBe(3);
      expect(p2).toBe(3);

      const reach = (owner: string): number => {
        const seen = new Set<number>();
        layout.initialBoard.forEach((state, index) => {
          if (state !== owner) return;
          for (const t of [...layout.neighbors[index]!, ...layout.jumpTargets[index]!]) {
            if (layout.initialBoard[t] === 'empty') seen.add(t);
          }
        });
        return seen.size;
      };
      expect(reach('player1')).toBe(reach('player2'));
    }
  });

  it('keeps the documented playable-space budget', () => {
    const counts = Object.fromEntries(getAllBoards().map((b) => [b.id, b.playableCount]));
    expect(counts).toEqual({ classic: 55, crossroads: 48, islands: 51 });
  });

  it('describes every layout for the picker', () => {
    for (const def of BOARD_DEFINITIONS) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.strategy.length).toBeGreaterThan(0);
    }
  });
});

describe('validateBoard', () => {
  it('reports an asymmetric obstacle set', () => {
    const geo = compileBoard({
      id: 'lopsided',
      name: 'lopsided',
      description: '',
      strategy: '',
      radius: 4,
      blocked: [{ q: 2, r: 0 }],
      starts: [{ q: 4, r: 0 }],
    });
    const issues = validateBoard(geo);
    expect(issues.some((i) => i.code === 'not-symmetric')).toBe(true);
  });

  it('reports a layout that is too small', () => {
    const geo = compileBoard({
      id: 'tiny',
      name: 'tiny',
      description: '',
      strategy: '',
      radius: 2,
      blocked: [],
      starts: [{ q: 2, r: 0 }],
    });
    expect(validateBoard(geo).some((i) => i.code === 'playable-count')).toBe(true);
  });

  it('reports a space that can never be occupied', () => {
    // Ring the corner (4,0) with obstacles so nothing can reach it, and do the
    // same to its mirror so the symmetry check does not fire instead.
    // Everything within two steps of (4,0) — clone range and jump range alike.
    const walls = symmetricPairs([
      { q: 4, r: -1 },
      { q: 3, r: 0 },
      { q: 3, r: 1 },
      { q: 4, r: -2 },
      { q: 3, r: -1 },
      { q: 2, r: 0 },
      { q: 2, r: 1 },
      { q: 2, r: 2 },
    ]);
    const geo = compileBoard({
      id: 'walled',
      name: 'walled',
      description: '',
      strategy: '',
      radius: 4,
      blocked: walls,
      starts: [{ q: 0, r: -4 }],
    });
    expect(validateBoard(geo).some((i) => i.code === 'unreachable')).toBe(true);
  });
});
