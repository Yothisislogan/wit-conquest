/**
 * Touch and pointer handling for the board.
 *
 * Taps are resolved to the *nearest* space rather than to whatever element the
 * finger happened to land on, and they snap to a highlighted destination when
 * one is close. Between them those two rules remove the two ways a hex board
 * normally punishes big fingers: dead gaps between tiles, and hexes that are
 * narrower than a fingertip on a small phone.
 *
 * Activation happens on pointer *up*, and only if the finger barely moved, so a
 * scroll or a stray drag never plays a move.
 */

import type { BoardRenderer } from './board-renderer.ts';

export interface BoardInputOptions {
  renderer: BoardRenderer;
  onActivate: (index: number) => void;
  /** Destinations currently highlighted; used for tap snapping. */
  preferredTargets: () => readonly number[];
  isEnabled: () => boolean;
  /** Fired on press-down so the UI can give immediate feedback. */
  onPressFeedback?: (index: number | null) => void;
}

/** Movement (in CSS pixels) above which a press is treated as a drag. */
const DRAG_TOLERANCE = 14;

export function installBoardInput(options: BoardInputOptions): () => void {
  const { renderer } = options;
  const svg = renderer.svg;

  let activePointer: number | null = null;
  let startX = 0;
  let startY = 0;
  let pressedIndex: number | null = null;

  const clearPress = (): void => {
    activePointer = null;
    pressedIndex = null;
    renderer.setPressed(null);
    options.onPressFeedback?.(null);
  };

  function onPointerDown(event: PointerEvent): void {
    if (!options.isEnabled()) return;
    // Secondary buttons and second fingers are ignored outright.
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (activePointer !== null) {
      clearPress();
      return;
    }

    activePointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;

    const index = renderer.resolvePoint(event.clientX, event.clientY, options.preferredTargets());
    pressedIndex = index;
    renderer.setPressed(index);
    options.onPressFeedback?.(index);
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== activePointer) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > DRAG_TOLERANCE) {
      // Treat it as a drag: abandon the press but keep the pointer captured so
      // the eventual pointerup does not fire a move.
      pressedIndex = null;
      renderer.setPressed(null);
      options.onPressFeedback?.(null);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== activePointer) return;
    const index = pressedIndex;
    const moved = Math.hypot(event.clientX - startX, event.clientY - startY) > DRAG_TOLERANCE;
    clearPress();

    if (index === null || moved || !options.isEnabled()) return;

    // Re-resolve at release position: a finger that rolled a few pixels should
    // still land where it was let go, not where it first touched down.
    const released = renderer.resolvePoint(event.clientX, event.clientY, options.preferredTargets());
    const chosen = released ?? index;
    renderer.setFocusCell(chosen);
    options.onActivate(chosen);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== activePointer) return;
    clearPress();
  }

  /**
   * Synthetic clicks (`detail === 0`) come from the keyboard or assistive tech,
   * which never produce pointer events. Real clicks are already handled above.
   */
  function onClick(event: MouseEvent): void {
    if (event.detail !== 0) return;
    if (!options.isEnabled()) return;
    const index = renderer.indexFromNode(event.target);
    if (index === null) return;
    renderer.setFocusCell(index);
    options.onActivate(index);
  }

  function onContextMenu(event: Event): void {
    // A long press on a monster should not open the OS callout mid-match.
    event.preventDefault();
  }

  function onDoubleClick(event: Event): void {
    event.preventDefault();
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('pointerleave', onPointerCancel);
  svg.addEventListener('click', onClick);
  svg.addEventListener('contextmenu', onContextMenu);
  svg.addEventListener('dblclick', onDoubleClick);

  return () => {
    svg.removeEventListener('pointerdown', onPointerDown);
    svg.removeEventListener('pointermove', onPointerMove);
    svg.removeEventListener('pointerup', onPointerUp);
    svg.removeEventListener('pointercancel', onPointerCancel);
    svg.removeEventListener('pointerleave', onPointerCancel);
    svg.removeEventListener('click', onClick);
    svg.removeEventListener('contextmenu', onContextMenu);
    svg.removeEventListener('dblclick', onDoubleClick);
  };
}
