/**
 * The title screen's drifting hex field.
 *
 * Positions and timings are drawn from a fixed seed rather than `Math.random`,
 * so the backdrop looks the same every time the menu opens — a field that
 * reshuffles on each visit reads as a glitch rather than as atmosphere.
 *
 * Each mote is a plain element carrying custom properties; all the animation
 * lives in CSS, which keeps the whole effect off the main thread and lets the
 * reduced-motion rules switch it off in one place.
 */

import { hexPolygonPoints } from '../game/hex.ts';
import { svgEl } from './svg.ts';

const MOTE_COUNT = 16;

/** Small deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE = ['var(--p1)', 'var(--p2)', 'var(--accent)', 'var(--accent)'];

/**
 * Fills `host` with drifting hexes. Safe to call repeatedly; the previous field
 * is replaced. Pass `enabled: false` to leave the backdrop empty entirely.
 */
export function renderSky(host: HTMLElement, { enabled = true }: { enabled?: boolean } = {}): void {
  if (!enabled) {
    host.replaceChildren();
    return;
  }

  const random = seeded(0x5f3a91);
  const motes: HTMLElement[] = [];

  for (let i = 0; i < MOTE_COUNT; i++) {
    const size = 2.2 + random() * 5.2;
    const mote = document.createElement('span');
    mote.className = 'mote';
    mote.style.setProperty('--x', `${(random() * 104 - 2).toFixed(2)}%`);
    mote.style.setProperty('--size', `${size.toFixed(2)}vmin`);
    // Bigger motes drift slower, which reads as depth.
    mote.style.setProperty('--dur', `${(26 + size * 3 + random() * 14).toFixed(1)}s`);
    mote.style.setProperty('--delay', `${(-random() * 34).toFixed(1)}s`);
    mote.style.setProperty('--sway', `${(random() * 18 - 9).toFixed(1)}vmin`);
    mote.style.setProperty('--spin', `${Math.round(random() * 360 - 180)}deg`);
    mote.style.setProperty('--peak', (0.16 + random() * 0.34).toFixed(2));
    mote.style.setProperty('--mote-color', PALETTE[Math.floor(random() * PALETTE.length)]!);

    const svg = svgEl('svg', { viewBox: '-1.1 -1.1 2.2 2.2', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(
      svgEl('polygon', {
        points: hexPolygonPoints(0, 0, 1),
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 0.16,
      }),
    );
    mote.appendChild(svg);
    motes.push(mote);
  }

  host.replaceChildren(...motes);
}
