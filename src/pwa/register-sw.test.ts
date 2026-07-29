/**
 * Update choreography is the one part of the PWA layer that can ruin a match in
 * progress: reload too eagerly and a player loses their turn, reload too timidly
 * and a tab is stranded on a build whose chunks the new worker has already
 * deleted. Neither failure is visible in a single-tab smoke test, so this suite
 * drives `registerServiceWorker` against a scripted `ServiceWorkerContainer` and
 * pins both edges down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register-sw.ts';

type Listener = () => void;

interface FakeTarget {
  addEventListener(type: string, listener: Listener): void;
  fire(type: string): void;
}

function createTarget(): FakeTarget {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    fire(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

interface FakeWorker extends FakeTarget {
  state: string;
  postMessage: ReturnType<typeof vi.fn>;
}

function createWorker(state = 'installed'): FakeWorker {
  return { ...createTarget(), state, postMessage: vi.fn() };
}

interface FakeRegistration extends FakeTarget {
  waiting: FakeWorker | null;
  installing: FakeWorker | null;
  update: ReturnType<typeof vi.fn>;
}

function createRegistration(waiting: FakeWorker | null = null): FakeRegistration {
  return {
    ...createTarget(),
    waiting,
    installing: null,
    update: vi.fn(() => Promise.resolve()),
  };
}

interface Harness {
  container: FakeTarget & { controller: object | null; register: ReturnType<typeof vi.fn> };
  registration: FakeRegistration;
  reload: ReturnType<typeof vi.fn>;
}

function install(registration: FakeRegistration, controlled = true): Harness {
  const reload = vi.fn();
  const container = {
    ...createTarget(),
    controller: controlled ? {} : null,
    register: vi.fn(() => Promise.resolve(registration)),
  };
  define('window', { location: { reload } });
  define('document', { baseURI: 'https://game.example/app/' });
  define('navigator', { serviceWorker: container });
  return { container, registration, reload };
}

const originals = new Map<string, PropertyDescriptor | undefined>();

function define(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** `container.register(...).then(...)` settles on the microtask queue. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  // The registration is a no-op under `vite dev`, so every behavioural test has
  // to look like a production bundle.
  vi.stubEnv('DEV', false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  originals.clear();
});

describe('registerServiceWorker', () => {
  it('does nothing in dev or without service worker support', () => {
    vi.stubEnv('DEV', true);
    install(createRegistration());
    expect(registerServiceWorker()).toBeNull();

    vi.stubEnv('DEV', false);
    define('window', { location: { reload: vi.fn() } });
    define('navigator', {});
    expect(registerServiceWorker()).toBeNull();
  });

  it('announces a waiting worker only when the page is already controlled', async () => {
    const first = install(createRegistration(createWorker()), false);
    const onUpdateReady = vi.fn();
    registerServiceWorker({ onUpdateReady });
    await flush();
    // No controller means this is the first install, not an update.
    expect(onUpdateReady).not.toHaveBeenCalled();
    expect(first.reload).not.toHaveBeenCalled();

    install(createRegistration(createWorker()));
    const onSecond = vi.fn();
    registerServiceWorker({ onUpdateReady: onSecond });
    await flush();
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it('wakes the waiting worker and reloads once the new controller takes over', async () => {
    const waiting = createWorker();
    const { container, reload } = install(createRegistration(waiting));
    const handle = registerServiceWorker()!;
    await flush();

    handle.applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();

    container.fire('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);

    // A second controller change (or a re-entrant event) must not reload again.
    container.fire('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads on a controller change the player did not ask for', async () => {
    const { container, reload } = install(createRegistration(createWorker()));
    registerServiceWorker();
    await flush();

    // `clients.claim()` on first install, and every update another tab accepts.
    container.fire('controllerchange');
    expect(reload).not.toHaveBeenCalled();
  });

  it('adopts an update another tab already activated instead of messaging a dead worker', async () => {
    const waiting = createWorker();
    const registration = createRegistration(waiting);
    const { reload } = install(registration);
    const onUpdateReady = vi.fn();
    const handle = registerServiceWorker({ onUpdateReady })!;
    await flush();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);

    // Another tab pressed its update button first: the worker we announced is
    // now the active one and the registration has no waiting worker left.
    waiting.state = 'activated';
    registration.waiting = null;

    handle.applyUpdate();
    // Posting to an activated worker is swallowed and no `controllerchange`
    // follows, so the tab would sit on a build whose chunks are gone.
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stays a no-op when no update was ever announced', async () => {
    const { reload } = install(createRegistration());
    const handle = registerServiceWorker()!;
    await flush();

    handle.applyUpdate();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not let a stale update click arm a later foreign controller change', async () => {
    const waiting = createWorker();
    const registration = createRegistration(waiting);
    const { container, reload } = install(registration);
    const handle = registerServiceWorker()!;
    await flush();

    // Another tab accepted this update; this tab's button is still on screen.
    waiting.state = 'activated';
    registration.waiting = null;
    handle.applyUpdate();
    const afterClick = reload.mock.calls.length;
    expect(afterClick).toBe(1);

    // Much later: yet another update, accepted in the *other* tab. This page
    // asked for nothing, so nothing may happen to it.
    container.fire('controllerchange');
    expect(reload.mock.calls.length - afterClick).toBe(0);
  });

  it('reloads anyway when activation never produces a controller change', async () => {
    vi.useFakeTimers();
    const waiting = createWorker();
    const { container, reload } = install(createRegistration(waiting));
    const handle = registerServiceWorker()!;
    await flush();

    handle.applyUpdate();
    vi.advanceTimersByTime(4999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // The safety net must not double-fire once the real event shows up late.
    container.fire('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads exactly once when the controller change beats the safety net', async () => {
    vi.useFakeTimers();
    const waiting = createWorker();
    const { container, reload } = install(createRegistration(waiting));
    const handle = registerServiceWorker()!;
    await flush();

    handle.applyUpdate();
    container.fire('controllerchange');
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('forwards checkForUpdate to the registration and swallows its failure', async () => {
    const registration = createRegistration();
    registration.update = vi.fn(() => Promise.reject(new Error('offline')));
    install(registration);
    const handle = registerServiceWorker()!;
    await flush();

    expect(() => handle.checkForUpdate()).not.toThrow();
    expect(registration.update).toHaveBeenCalledTimes(1);
    await flush();
  });
});
