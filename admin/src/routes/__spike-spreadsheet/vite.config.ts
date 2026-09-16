// Standalone production build of the spike entry, for the Spike C bundle
// measurement only. `admin/vite.config.ts` has a single `index.html` input and
// is a shared file this spike must not touch, so the measurement runs its own
// config with the same plugins:
//
//   pnpm exec vite build -c src/routes/__spike-spreadsheet/vite.config.ts
//
// The numbers it prints are what the real Phase 3a chunk will weigh: the same
// Vite 7, the same React 19.2, the same `lazy()` boundary.
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const adminRoot = resolve(import.meta.dirname, '..', '..', '..')

export default defineConfig({
  build: {
    outDir: resolve(adminRoot, 'dist-spike'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'index.html') },
  },
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  root: adminRoot,
})
