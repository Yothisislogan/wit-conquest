/**
 * Main-thread half of the PWA layer: registers `sw.js`, notices when a newer
 * worker is waiting, and applies the update only when the player asks for it.
 *
 * The service worker itself never calls `skipWaiting()` on its own, so the
 * decision of *when* to swap builds lives here — which means a match can never
 * be interrupted by a reload the player did not trigger.
 */

export interface SwRegistrationHandle {
  /** Asks the browser to re-fetch `sw.js`; cheap enough to call on demand. */
  checkForUpdate(): void;
  /** Activates the waiting worker and reloads the page exactly once. */
  applyUpdate(): void;
}

export interface RegisterServiceWorkerOptions {
  /**
   * Called once per waiting worker, on the main thread. Wire this to the
   * "A new version is ready" toast rather than reloading directly.
   */
  onUpdateReady?: () => void;
}

function supportsServiceWorker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

/**
 * `sw.js` is emitted next to `index.html`, while the module this code lives in
 * is emitted under `assets/`. Resolving against `import.meta.url` would
 * therefore look for `assets/sw.js`; resolving against the document base URL
 * lands on the right file *and* keeps working when the game is served from a
 * sub-path, which is the whole point of Vite's `base: './'`.
 */
function serviceWorkerUrl(): string {
  return new URL('sw.js', document.baseURI).toString();
}

export function registerServiceWorker(
  options: RegisterServiceWorkerOptions = {},
): SwRegistrationHandle | null {
  // In dev, Vite serves modules straight from source and never emits `sw.js`;
  // a worker here would only cache stale transforms and confuse HMR.
  if (import.meta.env.DEV) return null;
  if (!supportsServiceWorker()) return null;

  const container = navigator.serviceWorker;
  let registration: ServiceWorkerRegistration | null = null;
  let waitingWorker: ServiceWorker | null = null;
  let notified = false;
  let updateRequested = false;
  let reloading = false;

  const announceWaiting = (worker: ServiceWorker | null): void => {
    // Without an existing controller this is the very first install, not an
    // update: there is nothing for the player to accept.
    if (!worker || !container.controller) return;
    if (waitingWorker === worker && notified) return;
    waitingWorker = worker;
    notified = true;
    options.onUpdateReady?.();
  };

  const watchInstalling = (worker: ServiceWorker): void => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') announceWaiting(worker);
    });
  };

  container.addEventListener('controllerchange', () => {
    // Only a player-initiated update may reload. A controller change we did not
    // ask for (another tab accepting the update, or the initial `clients.claim()`)
    // must not yank the page away mid-turn, and the `reloading` latch stops the
    // reload from re-entering if the event fires more than once.
    if (!updateRequested || reloading) return;
    reloading = true;
    window.location.reload();
  });

  container
    .register(serviceWorkerUrl(), { scope: './' })
    .then((reg) => {
      registration = reg;
      if (reg.waiting) announceWaiting(reg.waiting);
      if (reg.installing) watchInstalling(reg.installing);
      reg.addEventListener('updatefound', () => {
        if (reg.installing) watchInstalling(reg.installing);
      });
    })
    .catch((error: unknown) => {
      // Registration fails on insecure origins and when the user has blocked
      // storage. The game is fully playable without offline support, so this is
      // logged and otherwise ignored.
      console.warn('[pwa] service worker registration failed', error);
    });

  return {
    checkForUpdate(): void {
      registration?.update().catch(() => {
        // Offline or rate-limited; the next check will pick the update up.
      });
    },
    applyUpdate(): void {
      const worker = waitingWorker ?? registration?.waiting ?? null;
      if (!worker) return;
      updateRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    },
  };
}
