import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Relative URLs in the build, so it works under any path prefix (e.g. GitHub Pages at /<repo>/).
  base: './',
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
    },
  },
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        city: fileURLToPath(new URL('./city.html', import.meta.url)),
        fps: fileURLToPath(new URL('./fps.html', import.meta.url)),
        wilds: fileURLToPath(new URL('./wilds.html', import.meta.url)),
        derby: fileURLToPath(new URL('./derby.html', import.meta.url)),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as any);
