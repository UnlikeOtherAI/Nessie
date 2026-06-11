import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiProxy = {
  '/api': {
    target: `http://127.0.0.1:${process.env.NESSIE_API_PORT ?? '5454'}`,
    changeOrigin: true,
    ws: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: 5455,
    strictPort: true,
    proxy: apiProxy,
    // The repo lives under /System/Volumes/Data/.internal/… (a macOS data-volume
    // firmlink path) where fsevents does not deliver change events, so Vite's
    // native watcher never fires and HMR appears dead. Poll instead so every
    // source edit reliably triggers an HMR update.
    watch: { usePolling: true, interval: 150 },
  },
  preview: {
    host: '0.0.0.0',
    port: 5455,
    strictPort: true,
    proxy: apiProxy,
  },
})
