/**
 * Original monster artwork, drawn as vectors in code.
 *
 * Every shape here was authored for this project; nothing is traced, sampled or
 * imported. Both teams are drawn inside a 2x2 box centred on the origin so a
 * piece can be dropped straight into a hex of circumradius 1 with one scale.
 *
 * The two teams differ by silhouette first and colour second:
 *   Team 1 "Blobs"  — round, soft, two eyes, a slow breathing idle.
 *   Team 2 "Spikes" — angular, seven-pointed, one eye, a restless idle.
 * That way the board stays readable for colour-blind players, in forced-colours
 * mode, and at the small sizes a phone board forces on us.
 */

import { svgEl } from './svg.ts';
import type { PlayerId } from '../game/types.ts';

export const TEAM_NAMES: Record<PlayerId, string> = { 1: 'Blobs', 2: 'Spikes' };
export const TEAM_ARTICLE: Record<PlayerId, string> = { 1: 'a Blob', 2: 'a Spike' };

/** Builds the seven-pointed outline used by team 2. */
function spikePoints(): string {
  const points: string[] = [];
  const spikes = 7;
  for (let i = 0; i < spikes * 2; i++) {
    const outer = i % 2 === 0;
    const radius = outer ? 1 : 0.56;
    // Start at the top so the silhouette reads as a crown, not a pinwheel.
    const angle = (Math.PI * 2 * i) / (spikes * 2) - Math.PI / 2;
    points.push(`${(Math.cos(angle) * radius).toFixed(4)},${(Math.sin(angle) * radius).toFixed(4)}`);
  }
  return points.join(' ');
}

const SPIKE_POINTS = spikePoints();

/**
 * A monster in local coordinates (-1..1). Wrap it in a positioned group before
 * adding it to the board — CSS animations on `.piece` need their own element so
 * they do not clobber the positioning transform.
 */
export function createMonster(player: PlayerId): SVGGElement {
  const idle = svgEl('g', { class: 'piece__idle' });

  if (player === 1) {
    // Soft blob: a closed cubic outline with a slightly heavier base so it
    // reads as sitting on the tile rather than floating.
    idle.appendChild(
      svgEl('path', {
        class: 'piece__body',
        d: 'M0,-1 C0.60,-1 1,-0.55 1,0.04 C1,0.64 0.60,1 0,1 C-0.60,1 -1,0.64 -1,0.04 C-1,-0.55 -0.60,-1 0,-1 Z',
      }),
    );
    idle.appendChild(
      svgEl('path', {
        class: 'piece__shade',
        d: 'M-0.86,0.36 C-0.60,0.86 -0.32,1 0,1 C0.32,1 0.60,0.86 0.86,0.36 C0.55,0.66 -0.55,0.66 -0.86,0.36 Z',
      }),
    );
    idle.appendChild(svgEl('ellipse', { class: 'piece__eye-white', cx: -0.35, cy: -0.2, rx: 0.28, ry: 0.33 }));
    idle.appendChild(svgEl('ellipse', { class: 'piece__eye-white', cx: 0.35, cy: -0.2, rx: 0.28, ry: 0.33 }));
    idle.appendChild(svgEl('circle', { class: 'piece__pupil', cx: -0.3, cy: -0.14, r: 0.145 }));
    idle.appendChild(svgEl('circle', { class: 'piece__pupil', cx: 0.4, cy: -0.14, r: 0.145 }));
    idle.appendChild(
      svgEl('path', {
        class: 'piece__mouth',
        d: 'M-0.3,0.34 Q0,0.66 0.3,0.34 Q0,0.5 -0.3,0.34 Z',
      }),
    );
  } else {
    idle.appendChild(svgEl('polygon', { class: 'piece__body', points: SPIKE_POINTS }));
    idle.appendChild(
      svgEl('path', {
        class: 'piece__shade',
        d: 'M-0.5,0.28 L0.5,0.28 L0.3,0.62 L-0.3,0.62 Z',
      }),
    );
    idle.appendChild(svgEl('circle', { class: 'piece__eye-white', cx: 0, cy: -0.08, r: 0.4 }));
    idle.appendChild(svgEl('circle', { class: 'piece__pupil', cx: 0.06, cy: -0.04, r: 0.19 }));
    // A single angled brow does most of the "different creature" work.
    idle.appendChild(
      svgEl('path', {
        class: 'piece__mouth',
        d: 'M-0.42,-0.44 L0.34,-0.24 L0.3,-0.09 L-0.44,-0.31 Z',
      }),
    );
    idle.appendChild(
      svgEl('path', {
        class: 'piece__mouth',
        d: 'M-0.28,0.42 L-0.14,0.56 L0,0.42 L0.14,0.56 L0.28,0.42 L0.22,0.66 L-0.22,0.66 Z',
      }),
    );
  }

  return svgEl('g', { class: `piece piece--p${player}` }, [idle]);
}

/** A standalone monster badge for score chips, menus and the result sheet. */
export function createMonsterBadge(player: PlayerId, size = 32): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '-1.15 -1.15 2.3 2.3',
    width: size,
    height: size,
    role: 'img',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `badge badge--p${player}`,
  });
  svg.appendChild(createMonster(player));
  return svg;
}

/** The masthead crest: both teams facing off over a hex. */
export function createCrest(): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 120 108',
    role: 'img',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'crest-grad', x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'var(--p1)' }));
  grad.appendChild(svgEl('stop', { offset: '50%', 'stop-color': 'var(--accent)' }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'var(--p2)' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  svg.appendChild(
    svgEl('polygon', {
      points: '60,2 112,29 112,79 60,106 8,79 8,29',
      fill: 'var(--surface)',
      stroke: 'url(#crest-grad)',
      'stroke-width': 5,
      'stroke-linejoin': 'round',
    }),
  );

  const left = svgEl('g', { transform: 'translate(41 54) scale(24)' });
  left.appendChild(createMonster(1));
  const right = svgEl('g', { transform: 'translate(79 54) scale(24)' });
  right.appendChild(createMonster(2));
  svg.appendChild(left);
  svg.appendChild(right);

  return svg;
}
