/**
 * Miniature previews of a layout for the board picker. Drawn from the same
 * compiled geometry as the real board, so a preview can never drift from what
 * the player actually gets.
 */

import type { BoardGeometry } from '../game/board.ts';
import { hexPolygonPoints } from '../game/hex.ts';
import { svgEl } from './svg.ts';

export function createBoardThumbnail(geo: BoardGeometry): SVGSVGElement {
  const { minX, minY, width, height } = geo.bounds;
  const pad = 0.3;
  const svg = svgEl('svg', {
    viewBox: `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${(width + pad * 2).toFixed(2)} ${(
      height +
      pad * 2
    ).toFixed(2)}`,
    role: 'img',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const points = hexPolygonPoints(0, 0, 0.9);
  for (const cell of geo.cells) {
    const state = geo.initialBoard[cell.index]!;
    const fill =
      state === 'blocked'
        ? 'var(--cell-blocked)'
        : state === 'player1'
          ? 'var(--p1)'
          : state === 'player2'
            ? 'var(--p2)'
            : 'var(--cell-empty-2)';
    svg.appendChild(
      svgEl('polygon', {
        points,
        transform: `translate(${cell.x.toFixed(3)} ${cell.y.toFixed(3)})`,
        fill,
        stroke: 'var(--cell-line)',
        'stroke-width': 0.06,
      }),
    );
  }

  return svg;
}
