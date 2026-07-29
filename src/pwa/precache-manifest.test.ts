/**
 * The precache list is generated, not written by hand, so the only place its
 * contents can be reviewed is here: this suite runs the `monster-territory-sw`
 * plugin over a synthetic bundle and asserts on the worker it emits.
 *
 * What it is really protecting is the install payload. Every path in this list
 * is downloaded and stored on *every* deploy (CACHE_VERSION changes each build),
 * so anything the running app never requests has no business being in it.
 */

import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config.ts';

interface EmittedAsset {
  type: 'asset';
  fileName: string;
  source: string;
}

/** The shape the plugin actually uses out of Rollup's plugin context. */
type GenerateBundle = (
  this: { emitFile(asset: EmittedAsset): void },
  options: Record<string, never>,
  bundle: Record<string, unknown>,
) => void;

function serviceWorkerPlugin(): Plugin {
  for (const entry of viteConfig.plugins ?? []) {
    if (entry && typeof entry === 'object' && 'name' in entry && entry.name === 'monster-territory-sw') {
      return entry as Plugin;
    }
  }
  throw new Error('the monster-territory-sw plugin is no longer registered in vite.config.ts');
}

/** Runs `generateBundle` over `fileNames` and returns the emitted `sw.js`. */
function emitServiceWorker(fileNames: string[]): string {
  const hook = serviceWorkerPlugin().generateBundle;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) throw new Error('the plugin no longer implements generateBundle');

  const emitted: EmittedAsset[] = [];
  const bundle = Object.fromEntries(fileNames.map((name) => [name, {}]));
  (handler as unknown as GenerateBundle).call(
    { emitFile: (asset) => void emitted.push(asset) },
    {},
    bundle,
  );

  const worker = emitted.find((asset) => asset.fileName === 'sw.js');
  if (!worker) throw new Error('the plugin no longer emits sw.js');
  return worker.source;
}

function precachePaths(source: string): string[] {
  const match = source.match(/const PRECACHE_PATHS = (\[[\s\S]*?\]);/);
  if (!match) throw new Error('emitted worker has no substituted PRECACHE_PATHS');
  return JSON.parse(match[1]!) as string[];
}

const BUNDLE = [
  'index.html',
  'assets/index-abc123.js',
  'assets/index-abc123.js.map',
  'assets/index-def456.css',
  'assets/ai-worker-ghi789.js',
  'assets/ai-worker-ghi789.js.map',
];

describe('generated precache manifest', () => {
  it('precaches the app shell and every runtime asset', () => {
    const paths = precachePaths(emitServiceWorker(BUNDLE));
    // `./` and the manifest are not bundle entries, so they are added by hand.
    expect(paths).toEqual(
      expect.arrayContaining([
        './',
        'index.html',
        'manifest.webmanifest',
        'assets/index-abc123.js',
        'assets/index-def456.css',
        // Fetched by `new Worker(...)` at runtime rather than linked from the
        // HTML, which is exactly why it has to be listed explicitly.
        'assets/ai-worker-ghi789.js',
      ]),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('leaves sourcemaps out of the install payload', () => {
    // Sourcemaps are only ever fetched by devtools, and they outweigh the real
    // assets ~3:1 — precaching them triples every install and every update.
    const paths = precachePaths(emitServiceWorker(BUNDLE));
    expect(paths.filter((path) => path.endsWith('.map'))).toEqual([]);
  });

  it('stamps a fresh cache version into every build', () => {
    const first = emitServiceWorker(BUNDLE);
    const version = first.match(/const CACHE_VERSION = "(v[a-z0-9]+)"/);
    expect(version).not.toBeNull();
    expect(first).not.toContain('__CACHE_VERSION__');
    expect(first).not.toContain('__PRECACHE_MANIFEST__');
  });
});
