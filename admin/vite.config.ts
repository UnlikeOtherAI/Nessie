import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiProxy = {
  '/api': {
    target: `http://127.0.0.1:${process.env.NESSIE_API_PORT ?? '5554'}`,
    changeOrigin: true,
    ws: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5555,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 5555,
    strictPort: true,
    proxy: apiProxy,
  },
})
