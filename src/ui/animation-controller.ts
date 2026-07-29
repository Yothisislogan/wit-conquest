/**
 * Resolves the effective motion preference and keeps it on the app root, where
 * the stylesheet reads it. Everything animated in the game flows through the
 * `--t-*` duration tokens, so this single attribute controls all of it.
 */

import type { MotionPreference } from '../data/settings.ts';

export class MotionController {
  #root: HTMLElement;
  #preference: MotionPreference = 'auto';
  #query: MediaQueryList | null = null;
  #listeners = new Set<(enabled: boolean) => void>();

  constructor(root: HTMLElement) {
    this.#root = root;
    if (typeof matchMedia === 'function') {
      this.#query = matchMedia('(prefers-reduced-motion: reduce)');
      this.#query.addEventListener('change', () => this.#apply());
    }
    this.#apply();
  }

  setPreference(preference: MotionPreference): void {
    this.#preference = preference;
    this.#apply();
  }

  /** True when animations longer than a frame should actually play. */
  get enabled(): boolean {
    if (this.#preference === 'reduced') return false;
    if (this.#preference === 'full') return true;
    return !(this.#query?.matches ?? false);
  }

  onChange(listener: (enabled: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #apply(): void {
    this.#root.setAttribute('data-motion', this.#preference);
    const enabled = this.enabled;
    for (const listener of this.#listeners) listener(enabled);
  }
}

/** Adds a class, waits for its animation, then removes it. Safe to spam. */
export function pulse(node: Element, className: string, fallbackMs = 250): void {
  node.classList.remove(className);
  void (node as HTMLElement).offsetWidth;
  node.classList.add(className);
  const done = () => node.classList.remove(className);
  node.addEventListener('animationend', done, { once: true });
  setTimeout(done, fallbackMs + 80);
}
