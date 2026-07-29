/**
 * Monster Territory service worker — build template.
 *
 * This file is never shipped as-is: the `monster-territory-sw` plugin in
 * vite.config.ts reads it at build time and substitutes the two placeholder
 * tokens declared immediately below before emitting `sw.js` next to
 * `index.html`. The plugin uses `String.prototype.replace` with a string
 * pattern, which only rewrites the *first* occurrence — so each token appears
 * exactly once in this file (not even in a comment) and only ever in value
 * position, which also keeps the un-substituted template parseable by
 * `node --check` and by the editor. sw-template.test.ts enforces all of that.
 *
 * Written in plain JS rather than TypeScript because it is copied verbatim into
 * the bundle without passing through the TS/Rollup pipeline.
 */

/** Scope-relative paths, e.g. `["./", "index.html", "assets/index-abc.js"]`. */
const PRECACHE_PATHS = __PRECACHE_MANIFEST__;

/** Changes on every build, which is what invalidates the previous cache. */
const CACHE_VERSION = __CACHE_VERSION__;

// The prefix lets `activate` recognise *our* caches and leave anything another
// tool on the same origin may have stored strictly alone.
const CACHE_PREFIX = 'monster-territory-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

/**
 * Resolving against `self.registration.scope` (rather than assuming the origin
 * root) is what lets the game be served from a sub-path such as
 * `https://example.com/games/monsters/` — GitHub Pages project sites do exactly
 * that, and Vite's `base: './'` already emits sub-path-safe HTML.
 */
function resolvePath(path) {
  return new URL(path, self.registration.scope).toString();
}

/**
 * `ignoreVary` matters more than it looks. A precache entry is fetched by the
 * worker itself, which sends no `Origin` header, while the page later requests
 * the same file as a CORS-mode module script, which does. Any server that
 * answers static assets with `Vary: Origin` — Vite's own preview server among
 * them — would therefore make every precached chunk a cache *miss*, and the
 * game would be offline-capable in name only. The filenames are content
 * hashed, so the bytes cannot disagree with the request headers anyway.
 */
const MATCH_OPTIONS = { ignoreVary: true };

/** The document served for any navigation we cannot fetch from the network. */
function shellUrl() {
  return resolvePath('index.html');
}

/**
 * Opaque (`type === 'opaque'`), error and partial responses are useless in a
 * cache: their bodies are unreadable or incomplete, so replaying them offline
 * hands the page a broken asset it can never recover from.
 */
function isCacheable(response) {
  return Boolean(
    response &&
      response.status === 200 &&
      response.type !== 'opaque' &&
      response.type !== 'opaqueredirect' &&
      response.type !== 'error',
  );
}

/**
 * A cache write can fail for reasons entirely outside our control — storage
 * quota, private-mode restrictions, the cache being evicted mid-write. None of
 * those should turn a perfectly good response into a failed request, so every
 * write is fire-and-forget.
 */
async function safePut(cache, request, response) {
  try {
    await cache.put(request, response);
    return true;
  } catch (error) {
    console.warn('[sw] cache write failed', error);
    return false;
  }
}

/**
 * `cache: 'reload'` bypasses the HTTP cache so a new version never precaches
 * the stale bytes the browser happens to still be holding. The option is
 * ignored by a few older engines and throws in a few others, hence the retry.
 */
async function fetchFresh(url) {
  try {
    return await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
  } catch (error) {
    if (error instanceof TypeError) return fetch(url, { credentials: 'same-origin' });
    throw error;
  }
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const shell = shellUrl();
  let shellCached = false;

  const results = await Promise.allSettled(
    PRECACHE_PATHS.map(async (path) => {
      const url = resolvePath(path);
      const response = await fetchFresh(url);
      if (!isCacheable(response)) throw new Error(`unexpected status ${response.status} for ${url}`);
      await cache.put(url, response);
      if (url === shell) shellCached = true;
    }),
  );

  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) console.warn('[sw] precache entry failed', failure.reason);

  // One missing hashed chunk degrades gracefully (the fetch handler falls back
  // to the network), but without the app shell there is no offline mode at all
  // — better to fail the install and keep the previous worker serving.
  if (!shellCached) throw new Error('[sw] refusing to install without the app shell');
}

self.addEventListener('install', (event) => {
  // Deliberately no skipWaiting() here: a player mid-match must never have the
  // page swapped out from under them. The new worker sits in `waiting` until
  // the page asks for it via a SKIP_WAITING message.
  event.waitUntil(precache());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      // Claim immediately so the very first load is controlled and works
      // offline on a second visit without an extra reload.
      await self.clients.claim();
    })(),
  );
});

/**
 * Navigations are network-first: a returning player should get the newest build
 * the moment they are online, and the cached shell only has to cover the case
 * where the network is gone.
 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      // Keyed under the shell URL rather than the requested URL: the game is a
      // single document, so this refreshes the offline fallback instead of
      // accumulating a near-identical copy per entry point.
      await safePut(cache, shellUrl(), response.clone());
    }
    return response;
  } catch (error) {
    const fallback =
      (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
      (await cache.match(shellUrl(), MATCH_OPTIONS)) ||
      (await cache.match(resolvePath('./'), MATCH_OPTIONS));
    if (fallback) return fallback;
    throw error;
  }
}

/**
 * Static assets are cache-first — every filename Vite emits is content-hashed,
 * so a cache hit is by definition the right bytes and the board renders without
 * touching the network. The background revalidation exists for the handful of
 * unhashed entries (the manifest, icons) that can change under a stable name.
 */
async function handleAsset(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, MATCH_OPTIONS);

  if (cached) {
    event.waitUntil(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (isCacheable(fresh)) await safePut(cache, request, fresh);
        } catch {
          // Offline, or the asset is gone. The cached copy is still served.
        }
      })(),
    );
    return cached;
  }

  try {
    const response = await fetch(request);
    if (isCacheable(response)) await safePut(cache, request, response.clone());
    return response;
  } catch {
    // A synthesised response keeps the failure legible in DevTools instead of
    // surfacing as an opaque "fetch failed".
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything that is not a plain same-origin GET — POSTs, analytics beacons,
  // CDN fonts, cross-origin media — is left entirely to the browser.
  if (request.method !== 'GET') return;

  // Chrome issues `only-if-cached` requests with mode `no-cors`; responding to
  // them from a worker throws. Let the browser handle them.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  // Range requests need a 206 we are not allowed to synthesise from a cache.
  if (request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(event));
});
