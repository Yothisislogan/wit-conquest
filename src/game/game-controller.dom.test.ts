/**
 * Controller-level tests. These run under jsdom because the controller talks to
 * `localStorage`; there is no Worker in jsdom, which also exercises the
 * synchronous fallback path of the AI client.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getBoard } from '../data/boards.ts';
import { GameController, type ControllerEvent } from './game-controller.ts';
import { getLegalMoves } from './moves.ts';
import type { GameState } from './types.ts';

function collect(controller: GameController): ControllerEvent[] {
  const events: ControllerEvent[] = [];
  controller.subscribe((event) => events.push(event));
  return events;
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

const classic = getBoard('classic');

beforeEach(() => {
  localStorage.clear();
});

describe('local two player', () => {
  it('starts with a mirrored board and player 1 to move', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    const events = collect(controller);
    controller.start();

    expect(controller.state.currentPlayer).toBe(1);
    expect(controller.state.scores).toEqual({ player1: 3, player2: 3 });
    expect(events.some((e) => e.type === 'state')).toBe(true);
    controller.dispose();
  });

  it('selects, re-selects and cancels without ever playing a move', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    controller.start();

    const pieces = controller.state.board.flatMap((s, i) => (s === 'player1' ? [i] : []));
    const [first, second] = pieces;

    controller.activateCell(first!);
    expect(controller.state.selectedCell).toBe(first);
    expect(controller.targets.clone.length + controller.targets.jump.length).toBeGreaterThan(0);

    controller.activateCell(second!);
    expect(controller.state.selectedCell).toBe(second);

    controller.activateCell(second!);
    expect(controller.state.selectedCell).toBeNull();

    expect(controller.state.turnNumber).toBe(1);
    expect(controller.state.lastMove).toBeNull();
    controller.dispose();
  });

  it('ignores a tap on an unreachable space without losing the selection', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    const events = collect(controller);
    controller.start();

    const piece = controller.state.board.findIndex((s) => s === 'player1');
    controller.activateCell(piece);

    const targets = new Set([...controller.targets.clone, ...controller.targets.jump]);
    const unreachable = controller.state.board.findIndex(
      (s, i) => s === 'empty' && !targets.has(i) && i !== piece,
    );
    expect(unreachable).toBeGreaterThanOrEqual(0);

    controller.activateCell(unreachable);
    expect(controller.state.selectedCell).toBe(piece);
    expect(controller.state.turnNumber).toBe(1);
    expect(events.filter((e) => e.type === 'rejected')).not.toHaveLength(0);
    controller.dispose();
  });

  it('plays a move by tapping a piece then a highlighted space', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    const events = collect(controller);
    controller.start();

    const piece = controller.state.board.findIndex((s) => s === 'player1');
    controller.activateCell(piece);
    const destination = controller.targets.clone[0]!;
    controller.activateCell(destination);

    expect(controller.state.board[destination]).toBe('player1');
    expect(controller.state.board[piece]).toBe('player1');
    expect(controller.state.currentPlayer).toBe(2);
    expect(controller.state.scores.player1).toBe(4);
    expect(events.some((e) => e.type === 'move')).toBe(true);
    controller.dispose();
  });

  it('refuses to move the other player’s monsters', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    controller.start();

    const enemy = controller.state.board.findIndex((s) => s === 'player2');
    controller.activateCell(enemy);
    expect(controller.state.selectedCell).toBeNull();
    controller.dispose();
  });

  it('keeps undo switched off unless the players opt in', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    controller.start();

    const piece = controller.state.board.findIndex((s) => s === 'player1');
    controller.activateCell(piece);
    controller.activateCell(controller.targets.clone[0]!);

    expect(controller.canUndo()).toBe(false);
    expect(controller.undo()).toBe(false);

    controller.setLocalUndoAllowed(true);
    expect(controller.canUndo()).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(controller.state.turnNumber).toBe(1);
    expect(controller.state.scores).toEqual({ player1: 3, player2: 3 });
    controller.dispose();
  });
});

describe('versus computer', () => {
  it('lets the human move, then answers with a legal computer move', async () => {
    const controller = new GameController({
      mode: 'vs-computer',
      boardId: 'classic',
      difficulty: 'easy',
      humanPlayer: 1,
    });
    controller.setPacing({ moveSettleMs: 5, minThinkingMs: 0 });
    const events = collect(controller);
    controller.start();

    const piece = controller.state.board.findIndex((s) => s === 'player1');
    const before = [...controller.state.board];
    controller.activateCell(piece);
    controller.activateCell(controller.targets.clone[0]!);

    expect(controller.state.currentPlayer).toBe(2);
    expect(controller.isInteractive()).toBe(false);

    await waitFor(() => controller.state.currentPlayer === 1);

    const moves = events.filter((e) => e.type === 'move');
    expect(moves).toHaveLength(2);
    const aiMove = moves[1]!;
    expect(aiMove.type === 'move' && aiMove.move.player).toBe(2);
    expect(controller.state.board).not.toEqual(before);
    expect(events.some((e) => e.type === 'thinking' && e.active)).toBe(true);
    controller.dispose();
  });

  it('offers one undo per human turn and rewinds past the computer reply', async () => {
    const controller = new GameController({
      mode: 'vs-computer',
      boardId: 'classic',
      difficulty: 'easy',
      humanPlayer: 1,
    });
    controller.setPacing({ moveSettleMs: 5, minThinkingMs: 0 });
    controller.start();

    const opening = [...controller.state.board];
    const piece = controller.state.board.findIndex((s) => s === 'player1');
    controller.activateCell(piece);
    controller.activateCell(controller.targets.clone[0]!);

    await waitFor(() => controller.state.currentPlayer === 1 && !controller.isThinking);

    expect(controller.canUndo()).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(controller.state.board).toEqual(opening);
    expect(controller.state.currentPlayer).toBe(1);
    // The allowance is spent until the human moves again.
    expect(controller.canUndo()).toBe(false);
    controller.dispose();
  });

  it('never lets the computer play an illegal move over a whole match', async () => {
    const controller = new GameController({
      mode: 'vs-computer',
      boardId: 'islands',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    controller.setPacing({ moveSettleMs: 0, minThinkingMs: 0 });

    const seen: GameState[] = [];
    controller.subscribe((event) => {
      if (event.type === 'move') seen.push(event.state);
    });
    controller.start();

    let guard = 0;
    while (controller.state.status === 'playing' && guard++ < 6_000) {
      if (controller.isInteractive()) {
        const legal = getLegalMoves(
          controller.geometry,
          controller.state.board,
          controller.state.currentPlayer,
        );
        expect(legal.length).toBeGreaterThan(0);
        controller.playMove(legal[0]!.from, legal[0]!.to);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    expect(controller.state.status).toBe('finished');
    expect(seen.length).toBeGreaterThan(4);
    for (const state of seen) {
      expect(state.scores.player1 + state.scores.player2).toBeLessThanOrEqual(
        controller.geometry.playableCount,
      );
    }
    controller.dispose();
  }, 60_000);
});

describe('persistence', () => {
  it('saves an in-progress match and resumes it', () => {
    const first = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    first.start();
    const piece = first.state.board.findIndex((s) => s === 'player1');
    first.activateCell(piece);
    first.activateCell(first.targets.clone[0]!);
    const snapshot = [...first.state.board];
    const turn = first.state.turnNumber;
    first.dispose();

    expect(GameController.hasResumableMatch('classic')).toBe(true);

    const second = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    second.start({ resume: true });
    expect(second.state.board).toEqual(snapshot);
    expect(second.state.turnNumber).toBe(turn);
    second.dispose();
  });

  it('clears the save on restart', () => {
    const controller = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    controller.start();
    const piece = controller.state.board.findIndex((s) => s === 'player1');
    controller.activateCell(piece);
    controller.activateCell(controller.targets.clone[0]!);

    controller.restart();
    expect(controller.state.turnNumber).toBe(1);
    expect(controller.state.board).toEqual(classic.initialBoard);
    controller.dispose();
  });

  it('starts a fresh match when the saved layout no longer matches', () => {
    const first = new GameController({
      mode: 'local-two-player',
      boardId: 'classic',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    first.start();
    const piece = first.state.board.findIndex((s) => s === 'player1');
    first.activateCell(piece);
    first.activateCell(first.targets.clone[0]!);
    first.dispose();

    expect(GameController.hasResumableMatch('islands')).toBe(false);

    const second = new GameController({
      mode: 'local-two-player',
      boardId: 'islands',
      difficulty: 'normal',
      humanPlayer: 1,
    });
    second.start({ resume: true });
    expect(second.state.turnNumber).toBe(1);
    second.dispose();
  });
});
