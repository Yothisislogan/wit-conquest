/**
 * The service worker template and the Vite plugin that consumes it are coupled
 * by two bare string tokens, and nothing in the type system connects them. This
 * suite is that connection: it reads both files off disk and fails the build if
 * the tokens ever drift apart or stop being substitutable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const templateSource = readFileSync(
  fileURLToPath(new URL('./sw-template.js', import.meta.url)),
  'utf8',
);

const viteConfigSource = readFileSync(
  fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
  'utf8',
);

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The tokens vite.config.ts actually passes to `String.prototype.replace`. */
function tokensSubstitutedByViteConfig(): string[] {
  const tokens = [...viteConfigSource.matchAll(/\.replace\(\s*'(__[A-Z0-9_]+__)'/g)].map(
    (match) => match[1]!,
  );
  return [...new Set(tokens)];
}

/** Mirrors the plugin's substitution so we can assert on the emitted worker. */
function substitute(paths: string[], version: string): string {
  return templateSource
    .replace('__PRECACHE_MANIFEST__', JSON.stringify(paths, null, 2))
    .replace('__CACHE_VERSION__', JSON.stringify(version));
}

describe('sw-template placeholders', () => {
  it('declares every token vite.config.ts substitutes', () => {
    const tokens = tokensSubstitutedByViteConfig();
    expect(tokens).toEqual(expect.arrayContaining(['__PRECACHE_MANIFEST__', '__CACHE_VERSION__']));
    for (const token of tokens) {
      expect(countOccurrences(templateSource, token), `token ${token}`).toBe(1);
    }
  });

  it('uses each token exactly once, in value position', () => {
    // `String.prototype.replace` with a string pattern only replaces the first
    // match, so a second occurrence would silently survive into the bundle.
    expect(countOccurrences(templateSource, '__PRECACHE_MANIFEST__')).toBe(1);
    expect(countOccurrences(templateSource, '__CACHE_VERSION__')).toBe(1);
    expect(templateSource).toMatch(/const\s+PRECACHE_PATHS\s*=\s*__PRECACHE_MANIFEST__\s*;/);
    expect(templateSource).toMatch(/const\s+CACHE_VERSION\s*=\s*__CACHE_VERSION__\s*;/);
  });

  it('parses both before and after substitution', () => {
    // The un-substituted template must stay valid JS so `node --check` and
    // editor tooling keep working on the source of truth.
    expect(() => new Function(templateSource)).not.toThrow();

    const emitted = substitute(['./', 'index.html', 'assets/index-abc123.js'], 'v1a2b3c');
    expect(() => new Function(emitted)).not.toThrow();
    expect(emitted).not.toContain('__PRECACHE_MANIFEST__');
    expect(emitted).not.toContain('__CACHE_VERSION__');
    expect(emitted).toContain('"assets/index-abc123.js"');
    expect(emitted).toContain('"v1a2b3c"');
  });
});

describe('sw-template behaviour contract', () => {
  it('only skips waiting in response to a SKIP_WAITING message', () => {
    expect(countOccurrences(templateSource, 'self.skipWaiting()')).toBe(1);
    // The guard has to be read before the call, otherwise the worker could take
    // over mid-match.
    expect(templateSource.indexOf("'SKIP_WAITING'")).toBeLessThan(
      templateSource.indexOf('self.skipWaiting()'),
    );
    expect(templateSource).toMatch(/addEventListener\('install'/);
    expect(templateSource).toMatch(/addEventListener\('activate'/);
    expect(templateSource).toMatch(/addEventListener\('fetch'/);
  });

  it('resolves precached paths against the registration scope', () => {
    expect(templateSource).toMatch(/new URL\(path,\s*self\.registration\.scope\)/);
  });

  it('claims clients and prunes stale versioned caches on activate', () => {
    expect(templateSource).toContain('self.clients.claim()');
    expect(templateSource).toMatch(/name\s*!==\s*CACHE_NAME/);
    expect(templateSource).toContain('caches.delete(name)');
  });

  it('ignores non-GET and cross-origin requests', () => {
    expect(templateSource).toMatch(/request\.method\s*!==\s*'GET'/);
    expect(templateSource).toMatch(/url\.origin\s*!==\s*self\.location\.origin/);
  });

  /**
   * Regression guard. The worker precaches assets with its own fetch, which
   * carries no `Origin` header, while the page requests the same files as
   * CORS-mode module scripts, which do. A server that answers with
   * `Vary: Origin` (Vite's preview server does) then turns every precache entry
   * into a miss, and offline play silently stops working.
   */
  it('ignores Vary when reading precached assets', () => {
    expect(templateSource).toContain('ignoreVary: true');

    // Every cache read must opt in, not just the one that was reported.
    const callSites = templateSource.split('cache.match(').slice(1);
    expect(callSites.length).toBeGreaterThan(0);
    for (const site of callSites) {
      const args = site.slice(0, site.indexOf(';'));
      expect(args, `cache.match(${args.trim()} must ignore Vary`).toMatch(
        /MATCH_OPTIONS|ignoreVary:\s*true/,
      );
    }
  });
});
