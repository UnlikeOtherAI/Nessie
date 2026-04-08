import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5555,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.NESSIE_API_PORT ?? '4317'}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
