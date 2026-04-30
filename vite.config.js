import { defineConfig } from 'vite';

/**
 * CivicPulse — Vite build config.
 *
 * The two perf concerns are:
 *
 * 1. maplibre-gl is ~1 MB minified (the bulk of the bundle). Splitting it
 *    into its own vendor chunk lets the browser cache it across deploys —
 *    a small src/* tweak doesn't bust the maplibre cache.
 *
 * 2. Layer modules (transit, traffic, wifi, …) are dynamically `import()`-ed
 *    by main.js, which Vite already code-splits per-module. We don't need
 *    a manualChunks entry for them; each becomes its own ~5–25 KB chunk and
 *    only the layers a given city actually uses get fetched.
 */
export default defineConfig({
  build: {
    // We've intentionally split the heavy vendor chunk; the warning would
    // otherwise fire on the maplibre-gl bundle alone.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // rolldown (Vite 8) expects a function form for manualChunks.
        // Pull anything under node_modules/maplibre-gl into its own
        // long-cached vendor chunk; let everything else flow into the
        // automatic per-module split that dynamic-import already triggers.
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'vendor-maplibre';
          return null;
        }
      }
    },
    // Hash filenames for long-term cacheability (Vite default already does
    // this, made explicit for clarity).
    assetsInlineLimit: 4096
  }
});
