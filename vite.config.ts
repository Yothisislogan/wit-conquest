import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Emits a small, dependency-free service worker whose precache list is derived
 * from the real build output. Keeping this in-repo (instead of pulling in a
 * workbox toolchain) keeps the shipped bundle small and the caching behaviour
 * easy to audit.
 */
function pwaServiceWorker(): Plugin {
  const templatePath = fileURLToPath(new URL('./src/pwa/sw-template.js', import.meta.url));
  const template = () => readFileSync(templatePath, 'utf8');

  return {
    name: 'monster-territory-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Paths are stored scope-relative and resolved against the service worker
      // registration scope at runtime, so the app works from a sub-path too.
      const assets = new Set<string>(['./', 'index.html', 'manifest.webmanifest']);
      for (const file of Object.keys(bundle)) {
        // Sourcemaps are devtools-only: the running app never requests one, yet
        // they outweigh the real assets roughly 3:1. Precaching them would make
        // every install download (and permanently store) ~400 KB of dead weight
        // — on every deploy, because CACHE_VERSION changes each build.
        if (file.endsWith('.map')) continue;
        // Web workers are fetched at runtime, everything else is linked from the
        // entry HTML; both need to be available offline.
        assets.add(file);
      }
      const version = `v${Date.now().toString(36)}`;
      const source = template()
        .replace('__PRECACHE_MANIFEST__', JSON.stringify([...assets].sort(), null, 2))
        .replace('__CACHE_VERSION__', JSON.stringify(version));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [pwaServiceWorker()],
  build: {
    target: 'es2022',
    cssTarget: 'safari15',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep the AI worker in its own chunk so the first paint is not blocked
        // by minimax code the menu never needs.
        manualChunks: undefined,
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
    port: 5173,
  },
});
