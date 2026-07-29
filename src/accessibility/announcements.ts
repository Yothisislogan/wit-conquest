/**
 * Screen-reader announcements and the spoken descriptions of board spaces.
 *
 * Everything the board communicates visually — whose turn it is, what a move
 * did, who was skipped, the final result — is mirrored here, because none of it
 * may depend on seeing the highlight colours.
 */

import type { BoardGeometry } from '../game/board.ts';
import type { GameMode } from '../data/settings.ts';
import { TEAM_NAMES } from '../ui/monsters.ts';
import type { CellState, Move, PlayerId, Scores } from '../game/types.ts';

export class Announcer {
  #polite: HTMLElement | null;
  #assertive: HTMLElement | null;
  #lastPolite = '';
  #pending: string[] = [];
  #flush: ReturnType<typeof setTimeout> | null = null;

  constructor(politeId = 'live-polite', assertiveId = 'live-assertive') {
    this.#polite = document.getElementById(politeId);
    this.#assertive = document.getElementById(assertiveId);
  }

  /**
   * Non-interrupting: turn changes, move results, score updates.
   *
   * A single move produces several of these back to back ("you cloned…",
   * "opponent's turn"). Writing them one after another into the same live
   * region would leave a screen reader announcing only the last, so messages
   * raised in the same tick are coalesced into one utterance.
   */
  say(message: string): void {
    if (!this.#polite || !message) return;
    this.#pending.push(message);
    if (this.#flush !== null) return;
    this.#flush = setTimeout(() => {
      this.#flush = null;
      const combined = [...new Set(this.#pending)].join(' ');
      this.#pending = [];
      if (!this.#polite || !combined) return;
      // Repeating identical text is silently dropped by most screen readers, so
      // nudge it with a zero-width space to force a re-announcement.
      this.#polite.textContent = combined === this.#lastPolite ? `${combined}​` : combined;
      this.#lastPolite = combined;
    }, 0);
  }

  /** Interrupting: results and errors that must not wait in the queue. */
  alert(message: string): void {
    if (!this.#assertive || !message) return;
    this.#assertive.textContent = '';
    // A fresh microtask makes the change observable to assistive tech.
    queueMicrotask(() => {
      if (this.#assertive) this.#assertive.textContent = message;
    });
  }

  clear(): void {
    if (this.#flush !== null) clearTimeout(this.#flush);
    this.#flush = null;
    this.#pending = [];
    if (this.#polite) this.#polite.textContent = '';
    if (this.#assertive) this.#assertive.textContent = '';
    this.#lastPolite = '';
  }
}

export interface DescribeContext {
  geo: BoardGeometry;
  mode: GameMode;
  humanPlayer: PlayerId;
  currentPlayer: PlayerId;
}

/** How a piece owner should be named, given the game mode. */
export function ownerName(ctx: DescribeContext, player: PlayerId): string {
  if (ctx.mode === 'local-two-player') return `${TEAM_NAMES[player]} monster`;
  return player === ctx.humanPlayer ? 'your monster' : 'opponent monster';
}

/** Full accessible label for a space, e.g. "Row 3, column 4. Empty space." */
export function describeCell(
  ctx: DescribeContext,
  index: number,
  state: CellState,
  target: 'clone' | 'jump' | null,
  selected: boolean,
): string {
  const cell = ctx.geo.cells[index]!;
  const position = `Row ${cell.row}, column ${cell.col}.`;

  let body: string;
  switch (state) {
    case 'blocked':
      body = 'Blocked space.';
      break;
    case 'empty':
      body = 'Empty space.';
      break;
    case 'player1':
      body = capitalise(`${ownerName(ctx, 1)}.`);
      break;
    case 'player2':
      body = capitalise(`${ownerName(ctx, 2)}.`);
      break;
  }

  const extras: string[] = [];
  if (selected) extras.push('Selected.');
  if (target === 'clone') extras.push('Valid clone move.');
  if (target === 'jump') extras.push('Valid jump move.');

  return [position, body, ...extras].join(' ');
}

export function describeTurn(ctx: DescribeContext, player: PlayerId): string {
  if (ctx.mode === 'local-two-player') return `${TEAM_NAMES[player]}, your turn.`;
  return player === ctx.humanPlayer ? 'Your turn.' : 'Opponent is thinking.';
}

export function describeMove(ctx: DescribeContext, move: Move, scores: Scores): string {
  const from = ctx.geo.cells[move.from]!;
  const to = ctx.geo.cells[move.to]!;
  const who =
    ctx.mode === 'local-two-player'
      ? TEAM_NAMES[move.player]
      : move.player === ctx.humanPlayer
        ? 'You'
        : 'Opponent';

  const action =
    move.type === 'clone'
      ? `cloned to row ${to.row}, column ${to.col}`
      : `jumped from row ${from.row}, column ${from.col} to row ${to.row}, column ${to.col}`;

  const flipped =
    move.converted.length > 0
      ? ` Converted ${move.converted.length} ${move.converted.length === 1 ? 'monster' : 'monsters'}.`
      : '';

  return `${who} ${action}.${flipped} Score ${TEAM_NAMES[1]} ${scores.player1}, ${TEAM_NAMES[2]} ${scores.player2}.`;
}

export function describeSkip(ctx: DescribeContext, player: PlayerId): string {
  if (ctx.mode === 'local-two-player') return `${TEAM_NAMES[player]} has no legal moves and is skipped.`;
  return player === ctx.humanPlayer
    ? 'You have no legal moves. Your turn is skipped.'
    : 'Opponent has no legal moves and is skipped.';
}

export function describeResult(
  ctx: DescribeContext,
  winner: PlayerId | 'tie',
  scores: Scores,
  label: string,
): string {
  const tally = `Final score: ${TEAM_NAMES[1]} ${scores.player1}, ${TEAM_NAMES[2]} ${scores.player2}.`;
  if (winner === 'tie') return `Match over. It is a tie. ${tally} ${label}.`;
  if (ctx.mode === 'local-two-player') return `Match over. ${TEAM_NAMES[winner]} win. ${tally} ${label}.`;
  return winner === ctx.humanPlayer
    ? `Match over. You win. ${tally} ${label}.`
    : `Match over. Opponent wins. ${tally} ${label}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
