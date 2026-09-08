import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const apiPort = process.env.NESSIE_API_PORT ?? '5454'

const apiProxy = {
  '/api': {
    target: `http://127.0.0.1:${apiPort}`,
    changeOrigin: true,
    ws: true,
  },
}

// Browser traffic may use the Vite `/api` proxy. An executor runs outside that
// browser, so it receives this direct API origin in its pairing invitation.
export const resolveExecutorApiPublicUrl = (
  env: Record<string, string | undefined>,
  port: string,
  development: boolean,
): string | undefined => env.NESSIE_API_PUBLIC_URL?.trim()
  || env.VITE_API_PUBLIC_URL?.trim()
  || env.VITE_API_BASE_URL?.trim()
  || (development ? `http://127.0.0.1:${port}` : undefined)

export default defineConfig(({ command, mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }
  const executorApiPublicUrl = resolveExecutorApiPublicUrl(env, apiPort, command === 'serve')
  const includeMemberManagementFixture = env.NESSIE_MEMBER_MANAGEMENT_E2E_FIXTURE === '1'

  return {
    ...(executorApiPublicUrl ? {
      define: {
        'import.meta.env.VITE_API_PUBLIC_URL': JSON.stringify(executorApiPublicUrl),
      },
    } : {}),
  plugins: [react(), tailwindcss()],
  // The CI-only member-management fixture must be a build input for preview
  // mode. The explicit flag keeps it out of ordinary production bundles.
  ...(includeMemberManagementFixture ? {
    build: {
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'index.html'),
          memberManagement: resolve(__dirname, 'e2e/member-management/index.html'),
        },
      },
    },
  } : {}),
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: 5455,
    strictPort: true,
    proxy: apiProxy,
    // Team hostnames in dev. Vite refuses a Host header it does not recognise,
    // and team hosts are created by people rather than listed in config, so the
    // whole `.localhost` tree is allowed rather than enumerated: opening
    // `http://design.acme.localhost:5455` then exercises the same host-mode
    // path production uses. Chrome and Firefox resolve `*.localhost` to
    // loopback on their own; Safari does not, and needs an /etc/hosts entry.
    allowedHosts: ['.localhost'],
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
  }
})
