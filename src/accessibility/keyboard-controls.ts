/**
 * Keyboard navigation for the board.
 *
 * The board is a roving-tabindex grid: one Tab stop, then arrow keys to move
 * focus. Left/Right walk along a row; Up/Down step to the geometrically closest
 * space in the neighbouring row, which is the only reading of "up" that makes
 * sense on a hex grid.
 */

import type { BoardRenderer } from '../ui/board-renderer.ts';

export interface KeyboardOptions {
  renderer: BoardRenderer;
  /** Whether board keys should do anything right now (menus take priority). */
  isEnabled: () => boolean;
  onActivate: (index: number) => void;
  onCancel: () => void;
  onRestart: () => void;
  /** Called after focus moves, so the new space can be announced. */
  onFocusChange?: (index: number) => void;
}

export function installKeyboardControls(options: KeyboardOptions): () => void {
  const { renderer } = options;
  const geo = renderer.geo;

  const rowOf = (index: number) => geo.cells[index]!.row;

  function stepInRow(index: number, direction: 1 | -1): number {
    const row = geo.rowIndices[rowOf(index) - 1]!;
    const position = row.indexOf(index);
    const next = position + direction;
    if (next < 0 || next >= row.length) return index;
    return row[next]!;
  }

  function stepRow(index: number, direction: 1 | -1): number {
    const targetRow = rowOf(index) + direction;
    const row = geo.rowIndices[targetRow - 1];
    if (!row || row.length === 0) return index;
    const { x } = geo.cells[index]!;
    let best = row[0]!;
    let bestDistance = Infinity;
    for (const candidate of row) {
      const distance = Math.abs(geo.cells[candidate]!.x - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  }

  function moveFocus(next: number): void {
    if (next === renderer.focusIndex) return;
    renderer.setFocusCell(next, { focus: true });
    options.onFocusChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!options.isEnabled()) return;

    // `R` is a global convenience key, but must never fire while typing.
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable === true;

    if (!typing && (event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      options.onRestart();
      return;
    }

    if (event.key === 'Escape') {
      options.onCancel();
      return;
    }

    // Everything below only applies when focus is inside the board.
    const focused = renderer.indexFromNode(document.activeElement);
    const current = focused ?? (renderer.focusIndex >= 0 ? renderer.focusIndex : 0);
    if (focused === null) return;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveFocus(stepInRow(current, -1));
        break;
      case 'ArrowRight':
        event.preventDefault();
        moveFocus(stepInRow(current, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(stepRow(current, -1));
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(stepRow(current, 1));
        break;
      case 'Home': {
        event.preventDefault();
        const row = geo.rowIndices[rowOf(current) - 1]!;
        moveFocus(row[0]!);
        break;
      }
      case 'End': {
        event.preventDefault();
        const row = geo.rowIndices[rowOf(current) - 1]!;
        moveFocus(row[row.length - 1]!);
        break;
      }
      case 'PageUp':
        event.preventDefault();
        moveFocus(geo.rowIndices[0]![0]!);
        break;
      case 'PageDown': {
        event.preventDefault();
        const lastRow = geo.rowIndices[geo.rowIndices.length - 1]!;
        moveFocus(lastRow[0]!);
        break;
      }
      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        options.onActivate(current);
        break;
      default:
        break;
    }
  }

  // Focusing any space by other means (a click, a screen reader) keeps the
  // roving tabindex in sync.
  function onFocusIn(event: FocusEvent): void {
    const index = renderer.indexFromNode(event.target);
    if (index !== null && index !== renderer.focusIndex) {
      renderer.setFocusCell(index);
    }
  }

  document.addEventListener('keydown', onKeyDown);
  renderer.svg.addEventListener('focusin', onFocusIn);

  return () => {
    document.removeEventListener('keydown', onKeyDown);
    renderer.svg.removeEventListener('focusin', onFocusIn);
  };
}
