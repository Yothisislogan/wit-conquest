/**
 * SVG board renderer.
 *
 * SVG (rather than canvas) because every space needs to be a real, labelled,
 * focusable node for screen readers and keyboard play — which the project
 * treats as a requirement, not a nice-to-have.
 *
 * The renderer is dumb on purpose: it is handed a `GameState` plus the current
 * move targets and makes the DOM match. It never decides anything about rules.
 */

import type { BoardGeometry } from '../game/board.ts';
import { hexPolygonPoints } from '../game/hex.ts';
import type { MoveTargets } from '../game/moves.ts';
import type { CellState, GameState, Move, PlayerId } from '../game/types.ts';
import { createMonster } from './monsters.ts';
import { svgEl, toggleAttr } from './svg.ts';

/** Visible hex is slightly inset so neighbours read as separate spaces… */
const HEX_DRAW_SCALE = 0.93;
/** …while the invisible hit shape stays full size, leaving no dead gaps. */
const HEX_HIT_SCALE = 1.02;
const PIECE_SCALE = 0.52;
const VIEW_PADDING = 0.18;

export type CellDescriber = (index: number, state: CellState, target: 'clone' | 'jump' | null) => string;

interface CellNodes {
  group: SVGGElement;
  pieceAnchor: SVGGElement;
  label: SVGTextElement;
  piece: SVGGElement | null;
  owner: CellState;
  description: string;
}

export interface BoardRendererOptions {
  geo: BoardGeometry;
  host: HTMLElement;
  describe: CellDescriber;
  /** Accessible name for the board as a whole. */
  label: string;
}

export class BoardRenderer {
  readonly svg: SVGSVGElement;
  readonly geo: BoardGeometry;
  #cells: CellNodes[] = [];
  #effects: SVGGElement;
  #describe: CellDescriber;
  #host: HTMLElement;
  #focusIndex = -1;
  #motionEnabled = true;

  constructor(options: BoardRendererOptions) {
    this.geo = options.geo;
    this.#describe = options.describe;
    this.#host = options.host;

    const { minX, minY, width, height } = this.geo.bounds;
    this.svg = svgEl('svg', {
      class: 'board',
      viewBox: `${(minX - VIEW_PADDING).toFixed(3)} ${(minY - VIEW_PADDING).toFixed(3)} ${(
        width +
        VIEW_PADDING * 2
      ).toFixed(3)} ${(height + VIEW_PADDING * 2).toFixed(3)}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'grid',
      'aria-label': options.label,
      tabindex: '-1',
    });

    const hexPoints = hexPolygonPoints(0, 0, HEX_DRAW_SCALE);
    const hitPoints = hexPolygonPoints(0, 0, HEX_HIT_SCALE);

    for (const indices of this.geo.rowIndices) {
      const row = svgEl('g', { role: 'row' });
      for (const index of indices) {
        row.appendChild(this.#buildCell(index, hexPoints, hitPoints));
      }
      this.svg.appendChild(row);
    }

    this.#effects = svgEl('g', { class: 'hopper', 'aria-hidden': 'true' });
    this.svg.appendChild(this.#effects);

    options.host.replaceChildren(this.svg);
  }

  #buildCell(index: number, hexPoints: string, hitPoints: string): SVGGElement {
    const cell = this.geo.cells[index]!;
    // Three-tone tiling, the standard hex colouring.
    const tone = (((cell.q - cell.r) % 3) + 3) % 3;

    const group = svgEl('g', {
      class: 'cell',
      transform: `translate(${cell.x.toFixed(4)} ${cell.y.toFixed(4)})`,
      'data-index': index,
      'data-tone': tone,
      'data-blocked': cell.blocked ? 'true' : 'false',
      role: 'gridcell',
      tabindex: '-1',
    });

    group.appendChild(svgEl('polygon', { class: 'hex', points: hexPoints }));
    group.appendChild(svgEl('polygon', { class: 'hit', points: hitPoints, fill: 'transparent' }));

    if (cell.blocked) {
      // A carved notch, so obstacles read without depending on colour.
      group.appendChild(
        svgEl('path', {
          class: 'blockmark',
          d: 'M-0.34,-0.34 L0.34,0.34 M0.34,-0.34 L-0.34,0.34',
        }),
      );
    }

    const pieceAnchor = svgEl('g', { class: 'piece-anchor', transform: `scale(${PIECE_SCALE})` });
    group.appendChild(pieceAnchor);

    group.appendChild(svgEl('circle', { class: 'marker marker--clone', r: 0.26 }));
    group.appendChild(svgEl('circle', { class: 'marker marker--jump', r: 0.36 }));
    group.appendChild(svgEl('circle', { class: 'marker marker--jump-inner', r: 0.1 }));
    group.appendChild(svgEl('polygon', { class: 'lastmove', points: hexPolygonPoints(0, 0, 0.8) }));
    group.appendChild(svgEl('polygon', { class: 'selectring', points: hexPolygonPoints(0, 0, 0.86) }));
    group.appendChild(svgEl('polygon', { class: 'focusring', points: hexPolygonPoints(0, 0, 0.72) }));

    const label = svgEl('text', { class: 'coordlabel', x: 0, y: 0.62 });
    label.textContent = `${cell.row}·${cell.col}`;
    group.appendChild(label);

    this.#cells[index] = {
      group,
      pieceAnchor,
      label,
      piece: null,
      owner: 'empty',
      description: '',
    };
    return group;
  }

  setMotionEnabled(enabled: boolean): void {
    this.#motionEnabled = enabled;
  }

  setCoordinatesVisible(visible: boolean): void {
    toggleAttr(this.svg, 'data-coords', visible ? 'true' : null);
  }

  /** Index for a DOM node inside the board, or `null`. */
  indexFromNode(node: EventTarget | null): number | null {
    if (!(node instanceof Element)) return null;
    const cell = node.closest('.cell');
    if (!cell) return null;
    const raw = cell.getAttribute('data-index');
    return raw === null ? null : Number(raw);
  }

  cellElement(index: number): SVGGElement | null {
    return this.#cells[index]?.group ?? null;
  }

  /** Makes the DOM match `state`. Cheap enough to call on every change. */
  render(state: GameState, targets: MoveTargets, options: { animateArrival?: boolean } = {}): void {
    const cloneSet = new Set(targets.clone);
    const jumpSet = new Set(targets.jump);
    const last = state.lastMove;

    for (let index = 0; index < this.#cells.length; index++) {
      const nodes = this.#cells[index]!;
      const cellState = state.board[index]!;
      const target = cloneSet.has(index) ? 'clone' : jumpSet.has(index) ? 'jump' : null;

      if (nodes.owner !== cellState) {
        this.#setPiece(nodes, cellState, options.animateArrival === true && last?.to === index);
        nodes.owner = cellState;
      }

      toggleAttr(nodes.group, 'data-target', target);
      toggleAttr(nodes.group, 'data-selected', state.selectedCell === index ? 'true' : null);
      toggleAttr(
        nodes.group,
        'data-lastmove',
        last?.to === index ? 'to' : last && last.type === 'jump' && last.from === index ? 'from' : null,
      );

      const description = this.#describe(index, cellState, target);
      if (description !== nodes.description) {
        nodes.description = description;
        nodes.group.setAttribute('aria-label', description);
      }

      const selectable = cellState !== 'blocked';
      toggleAttr(nodes.group, 'aria-disabled', selectable ? null : 'true');
    }
  }

  #setPiece(nodes: CellNodes, cellState: CellState, animate: boolean): void {
    if (nodes.piece) {
      nodes.piece.remove();
      nodes.piece = null;
    }
    if (cellState !== 'player1' && cellState !== 'player2') return;

    const player: PlayerId = cellState === 'player1' ? 1 : 2;
    const piece = createMonster(player);
    if (animate && this.#motionEnabled) piece.classList.add('is-arriving');
    nodes.pieceAnchor.appendChild(piece);
    nodes.piece = piece;
  }

  /** Roving focus: exactly one cell is tabbable at a time. */
  setFocusCell(index: number, { focus = false }: { focus?: boolean } = {}): void {
    if (this.#focusIndex >= 0) {
      this.#cells[this.#focusIndex]?.group.setAttribute('tabindex', '-1');
    }
    const nodes = this.#cells[index];
    if (!nodes) {
      this.#focusIndex = -1;
      return;
    }
    this.#focusIndex = index;
    nodes.group.setAttribute('tabindex', '0');
    if (focus) nodes.group.focus({ preventScroll: true });
  }

  get focusIndex(): number {
    return this.#focusIndex;
  }

  setPressed(index: number | null): void {
    for (const nodes of this.#cells) toggleAttr(nodes.group, 'data-pressed', null);
    if (index !== null) toggleAttr(this.#cells[index]!.group, 'data-pressed', 'true');
  }

  /**
   * Converts client coordinates into the index of the nearest space, preferring
   * a highlighted destination when one is close by. Nothing on a hex board is
   * more than half a hex from *some* space, so a tap can never fall into a gap
   * and quietly do nothing.
   */
  resolvePoint(clientX: number, clientY: number, preferred: readonly number[] = []): number | null {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const viewBox = this.svg.viewBox.baseVal;
    // preserveAspectRatio="xMidYMid meet": uniform scale, centred letterbox.
    const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
    const drawnWidth = viewBox.width * scale;
    const drawnHeight = viewBox.height * scale;
    const offsetX = rect.left + (rect.width - drawnWidth) / 2;
    const offsetY = rect.top + (rect.height - drawnHeight) / 2;

    const x = (clientX - offsetX) / scale + viewBox.x;
    const y = (clientY - offsetY) / scale + viewBox.y;

    const nearestOf = (indices: Iterable<number>): { index: number; distance: number } | null => {
      let best: { index: number; distance: number } | null = null;
      for (const index of indices) {
        const cell = this.geo.cells[index]!;
        const distance = Math.hypot(cell.x - x, cell.y - y);
        if (!best || distance < best.distance) best = { index, distance };
      }
      return best;
    };

    const nearest = nearestOf(this.geo.cells.keys());
    if (!nearest) return null;

    // Snap to a legal destination when the finger lands close to one — the most
    // effective single mis-tap guard on a small screen.
    if (preferred.length > 0) {
      const nearTarget = nearestOf(preferred);
      if (nearTarget && nearTarget.distance <= 1.35 && nearTarget.index !== nearest.index) {
        // Only steal the tap when it did not land squarely on another space.
        if (nearest.distance > 0.55) return nearTarget.index;
      }
    }

    // Outside the board entirely (a tap in the letterbox margin) is ignored.
    return nearest.distance <= 1.6 ? nearest.index : null;
  }

  /** Flies a monster from `from` to `to`. Resolves when the flight is over. */
  async animateJump(move: Move): Promise<void> {
    if (!this.#motionEnabled) return;
    const from = this.geo.cells[move.from]!;
    const to = this.geo.cells[move.to]!;
    const landing = this.#cells[move.to];
    if (!landing?.piece || typeof landing.piece.animate !== 'function') return;

    const hopper = svgEl('g', { transform: `translate(${from.x} ${from.y}) scale(${PIECE_SCALE})` });
    hopper.appendChild(createMonster(move.player));
    this.#effects.appendChild(hopper);

    const real = landing.piece;
    real.style.visibility = 'hidden';

    const duration = getDurationMs(this.svg, '--t-move', 200);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    try {
      await hopper.animate(
        [
          { transform: `translate(${from.x}px, ${from.y}px) scale(${PIECE_SCALE})` },
          {
            transform: `translate(${from.x + dx / 2}px, ${from.y + dy / 2 - 0.42}px) scale(${
              PIECE_SCALE * 1.14
            })`,
            offset: 0.5,
          },
          { transform: `translate(${to.x}px, ${to.y}px) scale(${PIECE_SCALE})` },
        ],
        { duration, easing: 'cubic-bezier(0.3, 0, 0.4, 1)', fill: 'forwards' },
      ).finished;
    } catch {
      /* Animation cancelled (screen change) — the board is already correct. */
    }

    hopper.remove();
    real.style.visibility = '';
  }

  /** Flip animation on every converted monster, with a short outward stagger. */
  animateConversions(move: Move): void {
    if (!this.#motionEnabled) return;
    const origin = this.geo.cells[move.to]!;
    const ordered = [...move.converted].sort((a, b) => {
      const ca = this.geo.cells[a]!;
      const cb = this.geo.cells[b]!;
      return Math.hypot(ca.x - origin.x, ca.y - origin.y) - Math.hypot(cb.x - origin.x, cb.y - origin.y);
    });

    ordered.forEach((index, order) => {
      const piece = this.#cells[index]?.piece;
      if (!piece) return;
      piece.style.animationDelay = `${order * 45}ms`;
      piece.classList.remove('is-converting');
      // Force a reflow so the class re-triggers when the same space flips twice.
      void piece.getBoundingClientRect();
      piece.classList.add('is-converting');
      piece.addEventListener(
        'animationend',
        () => {
          piece.classList.remove('is-converting');
          piece.style.animationDelay = '';
        },
        { once: true },
      );
    });

    this.#ripple(move.to);
  }

  #ripple(index: number): void {
    const cell = this.geo.cells[index]!;
    const ring = svgEl('circle', {
      class: 'ripple',
      cx: cell.x,
      cy: cell.y,
      r: 0.4,
    });
    this.#effects.appendChild(ring);
    if (typeof ring.animate !== 'function') {
      ring.remove();
      return;
    }
    const duration = getDurationMs(this.svg, '--t-convert', 300);
    const animation = ring.animate(
      [
        { r: 0.4, opacity: 0.8, strokeWidth: 0.12 },
        { r: 1.7, opacity: 0, strokeWidth: 0.02 },
      ],
      { duration: duration + 120, easing: 'ease-out' },
    );
    animation.finished.catch(() => undefined).finally(() => ring.remove());
  }

  destroy(): void {
    this.#host.replaceChildren();
    this.#cells = [];
  }
}

/** Reads a CSS duration custom property in milliseconds. */
function getDurationMs(node: Element, property: string, fallback: number): number {
  const raw = getComputedStyle(node).getPropertyValue(property).trim();
  if (!raw) return fallback;
  if (raw.endsWith('ms')) return Number.parseFloat(raw) || fallback;
  if (raw.endsWith('s')) return (Number.parseFloat(raw) || fallback / 1000) * 1000;
  return fallback;
}
