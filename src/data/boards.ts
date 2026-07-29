/**
 * The three shipped board layouts.
 *
 * Every layout is an original design for this project. All of them are built on
 * a regular hexagon of radius 4 (61 spaces) and every obstacle set is authored
 * through {@link symmetricPairs}, so 180° rotational symmetry — and therefore
 * side balance — is guaranteed by construction rather than by eyeballing.
 *
 * Player 1 starts on three alternating corners; player 2 receives the exact
 * 180° rotation of those corners, which `compileBoard` derives automatically.
 */

import { compileBoard, symmetricPairs, type BoardDefinition, type BoardGeometry } from '../game/board.ts';
import type { Axial } from '../game/types.ts';

const BOARD_RADIUS = 4;

/** Three alternating corners of the radius-4 hexagon. */
const CORNER_STARTS: Axial[] = [
  { q: BOARD_RADIUS, r: 0 },
  { q: 0, r: -BOARD_RADIUS },
  { q: -BOARD_RADIUS, r: BOARD_RADIUS },
];

/**
 * Classic — an open board with a light ring of six standing stones. Enough
 * texture to make position matter, little enough to keep the rules obvious.
 */
const CLASSIC: BoardDefinition = {
  id: 'classic',
  name: 'Classic',
  description: 'Open ground with a light ring of obstacles.',
  strategy: 'Wide open. Clone chains grow fast, so trades in the middle decide it.',
  radius: BOARD_RADIUS,
  blocked: symmetricPairs([
    { q: 2, r: 0 },
    { q: 2, r: -2 },
    { q: 0, r: -2 },
  ]),
  starts: CORNER_STARTS,
};

/**
 * Crossroads — a blocked hub with three spokes, splitting the middle into six
 * wedges that meet in a tight ring around the centre.
 */
const CROSSROADS: BoardDefinition = {
  id: 'crossroads',
  name: 'Crossroads',
  description: 'A blocked hub with spokes and six approach lanes.',
  strategy: 'Six lanes converge on a tight inner ring. Whoever holds the ring dictates the trades.',
  radius: BOARD_RADIUS,
  blocked: [
    { q: 0, r: 0 },
    ...symmetricPairs([
      { q: 2, r: 0 },
      { q: 3, r: 0 },
      { q: 0, r: 2 },
      { q: 0, r: 3 },
      { q: 2, r: -2 },
      { q: 3, r: -3 },
    ]),
  ],
  starts: CORNER_STARTS,
};

/**
 * Islands — two walls cut the board into three bands joined by two narrow gaps
 * each. Clone play is confined to a band; jumps are the only way across.
 */
const ISLANDS: BoardDefinition = {
  id: 'islands',
  name: 'Islands',
  description: 'Three bands linked by narrow corridors.',
  strategy: 'Walls stop clones but not jumps. Hold a corridor and you hold a whole band.',
  radius: BOARD_RADIUS,
  blocked: symmetricPairs([
    { q: -2, r: -2 },
    { q: -1, r: -2 },
    { q: 1, r: -2 },
    { q: 2, r: -2 },
    { q: 4, r: -2 },
  ]),
  starts: CORNER_STARTS,
};

export const BOARD_DEFINITIONS: readonly BoardDefinition[] = Object.freeze([
  CLASSIC,
  CROSSROADS,
  ISLANDS,
]);

export const DEFAULT_BOARD_ID = 'classic';

/**
 * A deliberately tiny board used only by the tutorial. It is kept out of
 * `BOARD_DEFINITIONS` so it never appears in the picker and is never subject to
 * the 45-65 space balance rules that apply to real layouts.
 */
const TUTORIAL: BoardDefinition = {
  id: 'tutorial',
  name: 'Training ground',
  description: 'A small board used by the tutorial.',
  strategy: 'Nineteen spaces, no obstacles — just enough room to learn the two moves.',
  radius: 2,
  blocked: [],
  starts: [],
};

let tutorialBoard: BoardGeometry | null = null;

export function getTutorialBoard(): BoardGeometry {
  tutorialBoard ??= compileBoard(TUTORIAL);
  return tutorialBoard;
}

const compiled = new Map<string, BoardGeometry>();

/** Compiles (and memoises) a board layout by id. */
export function getBoard(id: string): BoardGeometry {
  const cached = compiled.get(id);
  if (cached) return cached;

  const def = BOARD_DEFINITIONS.find((b) => b.id === id);
  if (!def) throw new Error(`Unknown board layout: ${id}`);

  const geo = compileBoard(def);
  compiled.set(id, geo);
  return geo;
}

/** All layouts, compiled. */
export function getAllBoards(): BoardGeometry[] {
  return BOARD_DEFINITIONS.map((def) => getBoard(def.id));
}

/** Falls back to the default layout when an unknown id is supplied. */
export function resolveBoardId(id: string | null | undefined): string {
  return BOARD_DEFINITIONS.some((b) => b.id === id) ? (id as string) : DEFAULT_BOARD_ID;
}
