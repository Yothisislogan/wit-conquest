import { describe, expect, it } from 'vitest';
import {
  applyMoveToBoard,
  classifyMove,
  countConversions,
  getConversions,
  getLegalMoves,
  getMoveTargets,
  hasLegalMove,
  ownsCell,
  undoMoveOnBoard,
} from './moves.ts';
import { indexAt, position, smallBoard } from './test-helpers.ts';
import { getAllBoards, getBoard } from '../data/boards.ts';
import type { CellState } from './types.ts';

const geo = smallBoard();

describe('move generation', () => {
  it('finds six clone destinations and twelve jump destinations from the centre', () => {
    const board = position(geo, { player1: [{ q: 0, r: 0 }] });
    const targets = getMoveTargets(geo, board, indexAt(geo, 0, 0), 1);
    expect(targets.clone).toHaveLength(6);
    expect(targets.jump).toHaveLength(12);
  });

  it('never offers occupied or blocked spaces', () => {
    const board = position(geo, {
      player1: [{ q: 0, r: 0 }],
      player2: [
        { q: 1, r: 0 },
        { q: 2, r: 0 },
      ],
    });
    const targets = getMoveTargets(geo, board, indexAt(geo, 0, 0), 1);
    expect(targets.clone).not.toContain(indexAt(geo, 1, 0));
    expect(targets.jump).not.toContain(indexAt(geo, 2, 0));
    expect(targets.clone).toHaveLength(5);
    expect(targets.jump).toHaveLength(11);
  });

  it('returns nothing for a space the player does not own', () => {
    const board = position(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 1, r: 0 }] });
    expect(getMoveTargets(geo, board, indexAt(geo, 1, 0), 1)).toEqual({ clone: [], jump: [] });
    expect(getMoveTargets(geo, board, indexAt(geo, 0, 1), 1)).toEqual({ clone: [], jump: [] });
    expect(getMoveTargets(geo, board, -1, 1)).toEqual({ clone: [], jump: [] });
    expect(getMoveTargets(geo, board, 999, 1)).toEqual({ clone: [], jump: [] });
  });

  it('classifies distance 1 as clone and distance 2 as jump', () => {
    const board = position(geo, { player1: [{ q: 0, r: 0 }] });
    expect(classifyMove(geo, board, indexAt(geo, 0, 0), indexAt(geo, 1, 0), 1)).toBe('clone');
    expect(classifyMove(geo, board, indexAt(geo, 0, 0), indexAt(geo, 2, 0), 1)).toBe('jump');
    expect(classifyMove(geo, board, indexAt(geo, 0, 0), indexAt(geo, 1, 1), 1)).toBe('jump');
  });

  it('rejects moves further than two steps, onto occupied spaces, or from enemy pieces', () => {
    const board = position(geo, { player1: [{ q: -2, r: 0 }], player2: [{ q: -1, r: 0 }] });
    // Distance 4 across the board.
    expect(classifyMove(geo, board, indexAt(geo, -2, 0), indexAt(geo, 2, 0), 1)).toBeNull();
    // Adjacent, but the destination already holds an enemy monster.
    expect(classifyMove(geo, board, indexAt(geo, -2, 0), indexAt(geo, -1, 0), 1)).toBeNull();
    // Moving the opponent's piece is not player 1's business.
    expect(classifyMove(geo, board, indexAt(geo, -1, 0), indexAt(geo, 0, 0), 1)).toBeNull();
    expect(classifyMove(geo, board, indexAt(geo, -1, 0), indexAt(geo, 0, 0), 2)).toBe('clone');
    // Out of bounds indices.
    expect(classifyMove(geo, board, -5, 0, 1)).toBeNull();
    expect(classifyMove(geo, board, 0, 12345, 1)).toBeNull();
  });

  it('never lets a jump land on a blocked space', () => {
    const crossroads = getBoard('crossroads');
    const blocked = crossroads.cells.filter((c) => c.blocked).map((c) => c.index);
    const board = [...crossroads.initialBoard];
    for (const move of getLegalMoves(crossroads, board, 1)) {
      expect(blocked).not.toContain(move.to);
    }
  });

  it('collapses duplicate clone destinations reachable from two of your pieces', () => {
    const board = position(geo, {
      player1: [
        { q: 0, r: 0 },
        { q: 1, r: -1 },
      ],
    });
    const moves = getLegalMoves(geo, board, 1);
    const cloneTargets = moves.filter((m) => m.type === 'clone').map((m) => m.to);
    expect(new Set(cloneTargets).size).toBe(cloneTargets.length);
    // (1,0) touches both pieces but is only offered once.
    expect(cloneTargets.filter((t) => t === indexAt(geo, 1, 0))).toHaveLength(1);
  });

  it('agrees with hasLegalMove in every case', () => {
    const cases: Array<CellState[]> = [
      position(geo, { player1: [{ q: 0, r: 0 }] }),
      position(geo, {}),
      position(geo, { player2: [{ q: 0, r: 0 }] }),
    ];
    for (const board of cases) {
      for (const player of [1, 2] as const) {
        expect(hasLegalMove(geo, board, player)).toBe(getLegalMoves(geo, board, player).length > 0);
      }
    }
  });

  it('reports no legal move when a lone piece is walled in', () => {
    // Fill the whole board with player 2, then place a single player 1 piece.
    const board = geo.cells.map(() => 'player2' as CellState);
    board[indexAt(geo, 0, 0)] = 'player1';
    expect(hasLegalMove(geo, board, 1)).toBe(false);
    expect(getLegalMoves(geo, board, 1)).toEqual([]);
  });

  it('knows who owns a cell', () => {
    const board = position(geo, { player1: [{ q: 0, r: 0 }], player2: [{ q: 1, r: 0 }] });
    expect(ownsCell(board, indexAt(geo, 0, 0), 1)).toBe(true);
    expect(ownsCell(board, indexAt(geo, 0, 0), 2)).toBe(false);
    expect(ownsCell(board, indexAt(geo, 1, 0), 2)).toBe(true);
  });
});

describe('conversions', () => {
  it('flips every adjacent enemy and nothing further away', () => {
    const board = position(geo, {
      player1: [{ q: 0, r: -1 }],
      player2: [
        { q: 1, r: 0 }, // adjacent to (0,0)
        { q: -1, r: 0 }, // adjacent to (0,0)
        { q: 2, r: 0 }, // two steps away, must survive
      ],
    });
    const target = indexAt(geo, 0, 0);
    const converted = getConversions(geo, board, target, 1);
    expect(converted.sort()).toEqual([indexAt(geo, -1, 0), indexAt(geo, 1, 0)].sort());
    expect(countConversions(geo, board, target, 1)).toBe(2);
    expect(converted).not.toContain(indexAt(geo, 2, 0));
  });

  it('never flips your own pieces or empty spaces', () => {
    const board = position(geo, {
      player1: [
        { q: 0, r: -1 },
        { q: 1, r: 0 },
      ],
    });
    expect(getConversions(geo, board, indexAt(geo, 0, 0), 1)).toEqual([]);
  });

  it('applies a clone without vacating the source and a jump with vacating it', () => {
    const clone = position(geo, { player1: [{ q: 0, r: 0 }] });
    applyMoveToBoard(geo, clone, { from: indexAt(geo, 0, 0), to: indexAt(geo, 1, 0), type: 'clone' }, 1);
    expect(clone[indexAt(geo, 0, 0)]).toBe('player1');
    expect(clone[indexAt(geo, 1, 0)]).toBe('player1');

    const jump = position(geo, { player1: [{ q: 0, r: 0 }] });
    applyMoveToBoard(geo, jump, { from: indexAt(geo, 0, 0), to: indexAt(geo, 2, 0), type: 'jump' }, 1);
    expect(jump[indexAt(geo, 0, 0)]).toBe('empty');
    expect(jump[indexAt(geo, 2, 0)]).toBe('player1');
  });

  it('undoes an applied move exactly, including conversions', () => {
    for (const type of ['clone', 'jump'] as const) {
      const before = position(geo, {
        player1: [{ q: 0, r: -1 }],
        player2: [
          { q: 1, r: 0 },
          { q: -1, r: 0 },
        ],
      });
      const board = [...before];
      const move = {
        from: indexAt(geo, 0, -1),
        to: type === 'clone' ? indexAt(geo, 0, 0) : indexAt(geo, 0, 1),
        type,
      };
      const converted = applyMoveToBoard(geo, board, move, 1);
      expect(board).not.toEqual(before);
      undoMoveOnBoard(board, move, 1, converted);
      expect(board).toEqual(before);
    }
  });
});

describe('shipped layouts', () => {
  it('gives both players legal opening moves on every board', () => {
    for (const board of getAllBoards()) {
      for (const player of [1, 2] as const) {
        expect(getLegalMoves(board, board.initialBoard, player).length).toBeGreaterThan(0);
      }
    }
  });

  it('offers each player the same number of opening moves (side balance)', () => {
    for (const board of getAllBoards()) {
      const p1 = getLegalMoves(board, board.initialBoard, 1).length;
      const p2 = getLegalMoves(board, board.initialBoard, 2).length;
      expect(p1, `${board.id} opening move counts`).toBe(p2);
    }
  });
});
