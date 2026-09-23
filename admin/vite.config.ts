import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Both ports come from the one resolver the `predev` guard and the browser
// harnesses read, so a worktree that takes its own pair moves the server, the
// `/api` proxy and the executor's pairing origin together. Hardcoding either
// here is what made a second checkout unable to run the app at all.
import { resolveAdminPort, resolveApiPort } from '../scripts/dev-ports.mjs'

const apiPort = String(resolveApiPort())
const adminPort = resolveAdminPort()

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
  const includeAppConnectScopeFixture = env.NESSIE_APP_CONNECT_SCOPE_E2E_FIXTURE === '1'
  const includeAgentProposalCardFixture = env.NESSIE_AGENT_PROPOSAL_CARD_E2E_FIXTURE === '1'
  const includeChannelAgentControlsFixture =
    env.NESSIE_CHANNEL_AGENT_CONTROLS_E2E_FIXTURE === '1'
  const includeChannelDecisionsFixture = env.NESSIE_CHANNEL_DECISIONS_E2E_FIXTURE === '1'
  const includeExecutorLocalMcpFixture = env.NESSIE_EXECUTOR_LOCAL_MCP_E2E_FIXTURE === '1'
  const includeExecutorPairingFixture = env.NESSIE_EXECUTOR_PAIRING_E2E_FIXTURE === '1'
  const includeExecutorAgentsFixture = env.NESSIE_EXECUTOR_AGENTS_E2E_FIXTURE === '1'
  const includeExecutorDetailFixture = env.NESSIE_EXECUTOR_DETAIL_E2E_FIXTURE === '1'
  const includeExecutorAttentionFixture = env.NESSIE_EXECUTOR_ATTENTION_E2E_FIXTURE === '1'
  const includeExecutorRunLauncherFixture =
    env.NESSIE_EXECUTOR_RUN_LAUNCHER_E2E_FIXTURE === '1'
  const includeRunStopFixture = env.NESSIE_RUN_STOP_E2E_FIXTURE === '1'
  const includeExecutorLeaseFixture = env.NESSIE_EXECUTOR_LEASE_E2E_FIXTURE === '1'
  const includeExecutorCodingSessionsFixture =
    env.NESSIE_EXECUTOR_CODING_SESSIONS_E2E_FIXTURE === '1'
  const includeLocalOllamaAgentsFixture = env.NESSIE_LOCAL_OLLAMA_AGENTS_E2E_FIXTURE === '1'
  const includeVisibilityAffordancesFixture =
    env.NESSIE_VISIBILITY_AFFORDANCES_E2E_FIXTURE === '1'
  const includeTaskSetsFixture = env.NESSIE_TASK_SETS_E2E_FIXTURE === '1'
  const includeTaskDialogFixture = env.NESSIE_TASK_DIALOG_E2E_FIXTURE === '1'
  const includeOverlayLayerFixture = env.NESSIE_OVERLAY_LAYER_E2E_FIXTURE === '1'

  return {
    ...(executorApiPublicUrl ? {
      define: {
        'import.meta.env.VITE_API_PUBLIC_URL': JSON.stringify(executorApiPublicUrl),
      },
    } : {}),
  plugins: [react(), tailwindcss()],
  // CI-only browser fixtures must be explicit preview inputs. Their flags keep
  // them out of ordinary production bundles.
  ...(includeMemberManagementFixture
    || includeAppConnectScopeFixture
    || includeAgentProposalCardFixture
    || includeChannelAgentControlsFixture
    || includeChannelDecisionsFixture
    || includeVisibilityAffordancesFixture
    || includeTaskSetsFixture
    || includeTaskDialogFixture
    || includeOverlayLayerFixture
    || includeExecutorLocalMcpFixture
    || includeExecutorPairingFixture
    || includeExecutorAgentsFixture
    || includeExecutorDetailFixture
    || includeExecutorAttentionFixture
    || includeExecutorRunLauncherFixture
    || includeRunStopFixture
    || includeExecutorLeaseFixture
    || includeExecutorCodingSessionsFixture
    || includeLocalOllamaAgentsFixture ? {
    build: {
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'index.html'),
          ...(includeMemberManagementFixture ? {
            memberManagement: resolve(__dirname, 'e2e/member-management/index.html'),
          } : {}),
          ...(includeAppConnectScopeFixture ? {
            appConnectScope: resolve(__dirname, 'e2e/app-connect-scope/index.html'),
          } : {}),
          ...(includeAgentProposalCardFixture ? {
            agentProposalCard: resolve(__dirname, 'e2e/agent-proposal-card/index.html'),
          } : {}),
          ...(includeChannelAgentControlsFixture ? {
            channelAgentControls: resolve(__dirname, 'e2e/channel-agent-controls/index.html'),
          } : {}),
          ...(includeChannelDecisionsFixture ? {
            channelDecisions: resolve(__dirname, 'e2e/channel-decisions/index.html'),
          } : {}),
          ...(includeVisibilityAffordancesFixture ? {
            visibilityAffordances: resolve(__dirname, 'e2e/visibility-affordances/index.html'),
          } : {}),
          ...(includeTaskSetsFixture ? {
            taskSets: resolve(__dirname, 'e2e/task-sets/index.html'),
          } : {}),
          ...(includeTaskDialogFixture ? {
            taskDialog: resolve(__dirname, 'e2e/task-dialog/index.html'),
          } : {}),
          ...(includeOverlayLayerFixture ? {
            overlayLayer: resolve(__dirname, 'e2e/overlay-layer/index.html'),
          } : {}),
          ...(includeExecutorLocalMcpFixture ? {
            executorLocalMcp: resolve(__dirname, 'e2e/executor-local-mcp/index.html'),
          } : {}),
          ...(includeExecutorPairingFixture ? {
            executorPairing: resolve(__dirname, 'e2e/executor-pairing/index.html'),
          } : {}),
          ...(includeExecutorAgentsFixture ? {
            executorAgents: resolve(__dirname, 'e2e/executor-agents/index.html'),
          } : {}),
          ...(includeExecutorDetailFixture ? {
            executorDetail: resolve(__dirname, 'e2e/executor-detail/index.html'),
          } : {}),
          ...(includeExecutorAttentionFixture ? {
            executorAttention: resolve(__dirname, 'e2e/executor-attention/index.html'),
          } : {}),
          ...(includeExecutorRunLauncherFixture ? {
            executorRunLauncher: resolve(__dirname, 'e2e/executor-run-launcher/index.html'),
          } : {}),
          ...(includeRunStopFixture ? {
            runStop: resolve(__dirname, 'e2e/run-stop/index.html'),
          } : {}),
          ...(includeExecutorLeaseFixture ? {
            executorLease: resolve(__dirname, 'e2e/executor-lease/index.html'),
          } : {}),
          ...(includeExecutorCodingSessionsFixture ? {
            executorCodingSessions: resolve(__dirname, 'e2e/executor-coding-sessions/index.html'),
          } : {}),
          ...(includeLocalOllamaAgentsFixture ? {
            localOllamaAgents: resolve(__dirname, 'e2e/local-ollama-agents/index.html'),
          } : {}),
        },
      },
    },
  } : {}),
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '0.0.0.0',
    port: adminPort,
    // Still strict: a silent hop to the next free port is how a browser ends
    // up on one worktree's admin while the proxy talks to another's API. The
    // port is configurable now, so strictness costs nothing.
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
    port: adminPort,
    strictPort: true,
    proxy: apiProxy,
  },
  }
})
