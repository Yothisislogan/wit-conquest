/**
 * Screen and dialog plumbing: which section is visible, and how modal overlays
 * behave (focus capture, Escape to close, focus restored on exit).
 *
 * Kept deliberately small — this is a game, not an app framework — but complete
 * enough that keyboard and screen-reader users are never stranded behind a
 * dialog.
 */

export type ScreenName = 'menu' | 'game' | 'tutorial' | 'howto' | 'settings';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export class ScreenManager {
  #screens = new Map<ScreenName, HTMLElement>();
  #current: ScreenName = 'menu';
  #history: ScreenName[] = [];
  #onChange = new Set<(screen: ScreenName) => void>();

  constructor(root: ParentNode = document) {
    for (const node of root.querySelectorAll<HTMLElement>('[data-screen]')) {
      const name = node.dataset.screen as ScreenName;
      this.#screens.set(name, node);
    }
  }

  get current(): ScreenName {
    return this.#current;
  }

  onChange(listener: (screen: ScreenName) => void): void {
    this.#onChange.add(listener);
  }

  show(name: ScreenName, options: { remember?: boolean } = {}): void {
    if (!this.#screens.has(name)) return;
    if (options.remember !== false && name !== this.#current) this.#history.push(this.#current);

    for (const [key, node] of this.#screens) {
      const visible = key === name;
      node.hidden = !visible;
      node.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    this.#current = name;
    // Move focus to the top of the new screen so keyboard users are not left
    // pointing at a node that is now hidden.
    const first = this.#screens.get(name)?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
    for (const listener of this.#onChange) listener(name);
  }

  back(fallback: ScreenName = 'menu'): void {
    const previous = this.#history.pop() ?? fallback;
    this.show(previous, { remember: false });
  }
}

export interface DialogOptions {
  onClose?: () => void;
  /** Element focused when the dialog opens; defaults to the first control. */
  initialFocus?: HTMLElement | null;
  /** Set false for dialogs that must be answered (e.g. the result sheet). */
  dismissible?: boolean;
}

/**
 * A minimal modal: traps Tab, closes on Escape and backdrop click, and returns
 * focus where it came from.
 */
export class Dialog {
  #overlay: HTMLElement;
  #panel: HTMLElement;
  #previousFocus: HTMLElement | null = null;
  #options: DialogOptions = {};
  #open = false;
  #onKeyDown: (event: KeyboardEvent) => void;
  #onPointerDown: (event: Event) => void;

  constructor(overlay: HTMLElement, panel: HTMLElement) {
    this.#overlay = overlay;
    this.#panel = panel;

    this.#onKeyDown = (event) => {
      if (!this.#open) return;
      if (event.key === 'Escape' && this.#options.dismissible !== false) {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = [...this.#panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (active === first || !this.#panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    this.#onPointerDown = (event) => {
      if (!this.#open || this.#options.dismissible === false) return;
      if (event.target === this.#overlay) this.close();
    };
  }

  get isOpen(): boolean {
    return this.#open;
  }

  open(options: DialogOptions = {}): void {
    if (this.#open) return;
    this.#options = options;
    this.#previousFocus = document.activeElement as HTMLElement | null;
    this.#overlay.hidden = false;
    this.#open = true;

    document.addEventListener('keydown', this.#onKeyDown, true);
    this.#overlay.addEventListener('pointerdown', this.#onPointerDown);

    const target = options.initialFocus ?? this.#panel.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#overlay.hidden = true;
    document.removeEventListener('keydown', this.#onKeyDown, true);
    this.#overlay.removeEventListener('pointerdown', this.#onPointerDown);
    this.#previousFocus?.focus?.({ preventScroll: true });
    this.#options.onClose?.();
  }
}

/** Wires a `role="radiogroup"` of buttons and reports the chosen value. */
export function bindSegmented(
  container: HTMLElement,
  onSelect: (value: string) => void,
): (value: string) => void {
  const items = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];

  const setValue = (value: string): void => {
    for (const item of items) {
      const checked = item.dataset.value === value;
      item.setAttribute('aria-checked', checked ? 'true' : 'false');
      item.setAttribute('tabindex', checked ? '0' : '-1');
    }
  };

  container.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    if (!item || !container.contains(item) || !item.dataset.value) return;
    setValue(item.dataset.value);
    onSelect(item.dataset.value);
  });

  // Arrow keys inside a radio group are expected behaviour for screen readers.
  container.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const active = document.activeElement as HTMLElement | null;
    const index = items.findIndex((item) => item === active);
    if (index === -1) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = items[(index + delta + items.length) % items.length]!;
    next.focus();
    if (next.dataset.value) {
      setValue(next.dataset.value);
      onSelect(next.dataset.value);
    }
  });

  return setValue;
}

/** Wires a `role="switch"` button. Returns a setter for the checked state. */
export function bindSwitch(
  node: HTMLElement,
  onToggle: (checked: boolean) => void,
): (checked: boolean) => void {
  const setChecked = (checked: boolean): void => {
    node.setAttribute('aria-checked', checked ? 'true' : 'false');
  };
  node.addEventListener('click', () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    setChecked(next);
    onToggle(next);
  });
  return setChecked;
}
