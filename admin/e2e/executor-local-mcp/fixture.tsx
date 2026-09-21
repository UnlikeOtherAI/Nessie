import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  ExecutorIdSchema,
  OrganizationIdSchema,
  type ExecutorLocalMcpStatus,
  type ExecutorRecordResponse,
  type KelpieDevice,
} from '@nessie/schemas'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { ExecutorDetailPanels } from '../../src/components/features/executors/ExecutorDetailPanels'
import { ExecutorGrantedSuite } from '../../src/components/features/executors/ExecutorGrantedSuite'
import { ExecutorReviewedPolicy } from '../../src/components/features/executors/ExecutorReviewedPolicy'
import type {
  ExecutorAccessViewWithLocalMcp,
  ExecutorDescriptorRevisionView,
} from '../../src/facades/executors/local-mcp'
import '../../src/styles.css'

/**
 * The executor detail surface for local MCP servers, driven by the real
 * components over a stubbed access view — no API, no database.
 *
 * Every state the screen can be in gets a `?scenario=`, because the states
 * are the feature: "not installed" and "installed but nothing answered" send
 * a person to opposite machines, and a ten-minute-old inventory rendered as
 * current is the one lie this screen must never tell.
 */

// Parsed, not cast: these are branded ids, and `.parse` both satisfies the
// brand and proves the fixture's stand-ins are the shape the product would
// actually hand this screen.
const EXECUTOR_ID = ExecutorIdSchema.parse('00000000-0000-4000-8000-0000000000e1')
const ORGANIZATION_ID = OrganizationIdSchema.parse('00000000-0000-4000-8000-0000000000a1')

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const daysAgo = (days: number) => minutesAgo(days * 24 * 60)

const executor: ExecutorRecordResponse = {
  authorizationRevision: 1,
  createdAt: daysAgo(30),
  id: EXECUTOR_ID,
  label: 'Studio Mac',
  lastSeenAt: minutesAgo(1),
  profiles: ['connected_browser'],
  scope: { kind: 'organization', organizationId: ORGANIZATION_ID },
  status: 'online',
  updatedAt: minutesAgo(1),
}

const mcpRevision: ExecutorDescriptorRevisionView = {
  localPolicyDigest: `sha256:${'b'.repeat(64)}`,
  mcpServers: ['kelpie'],
  operationKeys: ['mcp.tools', 'mcp.call'],
  profiles: ['connected_browser'],
  reviewStatus: 'active',
  revision: 3,
}

const access = (
  localMcp?: ExecutorLocalMcpStatus[],
  descriptorRevisions: ExecutorDescriptorRevisionView[] = [mcpRevision],
): ExecutorAccessViewWithLocalMcp => ({
  canManage: true,
  descriptorRevisions,
  effectiveAccess: {
    organizationRole: 'owner',
    privateAssignment: 'none',
    projectRole: null,
  },
  executorId: EXECUTOR_ID,
  ...(localMcp ? { localMcp } : {}),
})

const pairedMac: KelpieDevice = {
  address: '192.168.1.20',
  display: { height: 982, width: 1512 },
  engine: 'webkit',
  id: 'kb-mac-01',
  lastSeenAt: minutesAgo(2),
  model: 'MacBookPro18,2',
  name: 'Ondrej’s MacBook Pro',
  paired: true,
  platform: 'macos',
  port: 8421,
  runtimeMode: 'gui',
  version: '0.1.11',
}

const unpairedIphone: KelpieDevice = {
  address: '192.168.1.44',
  display: { height: 874, width: 402 },
  engine: 'webkit',
  id: 'kb-ios-02',
  lastSeenAt: minutesAgo(9),
  model: 'iPhone 17 Pro',
  name: 'Ondrej’s iPhone',
  paired: false,
  platform: 'ios',
  port: 9100,
  runtimeMode: 'gui',
  version: '0.1.11',
}

const headlessLinux: KelpieDevice = {
  address: '192.168.1.60',
  engine: 'chromium',
  id: 'kb-lnx-03',
  lastSeenAt: minutesAgo(31),
  name: 'ci-runner-2',
  paired: true,
  platform: 'linux',
  port: 8777,
  runtimeMode: 'headless',
  version: '0.1.10',
}

const kelpieStatus = (
  overrides: Partial<ExecutorLocalMcpStatus>,
): ExecutorLocalMcpStatus => ({
  available: true,
  observedAt: minutesAgo(4),
  server: 'kelpie',
  serverVersion: '0.1.11',
  toolCount: 145,
  ...overrides,
})

const scenarios: Record<string, ExecutorAccessViewWithLocalMcp> = {
  'available': access([
    kelpieStatus({ kelpieDevices: [pairedMac, unpairedIphone, headlessLinux] }),
  ]),
  'not-installed': access([
    kelpieStatus({
      available: false,
      reason: 'not_installed',
      serverVersion: undefined,
      toolCount: undefined,
    }),
  ]),
  'launch-failed': access([
    kelpieStatus({
      available: false,
      detail: 'The server process exited with status 1 during launch.',
      reason: 'launch_failed',
      serverVersion: undefined,
      toolCount: undefined,
    }),
  ]),
  'handshake-failed': access([
    kelpieStatus({
      available: false,
      detail: 'The server closed the connection during initialize.',
      reason: 'handshake_failed',
      serverVersion: undefined,
      toolCount: undefined,
    }),
  ]),
  'unsupported-platform': access([
    kelpieStatus({
      available: false,
      reason: 'unsupported_platform',
      serverVersion: undefined,
      toolCount: undefined,
    }),
  ]),
  'not-probed': access([
    kelpieStatus({
      available: false,
      reason: 'not_probed',
      serverVersion: undefined,
      toolCount: undefined,
    }),
  ]),
  'no-browsers': access([kelpieStatus({ kelpieDevices: [] })]),
  'unprobed-inventory': access([kelpieStatus({ catalogDigest: `sha256:${'c'.repeat(64)}` })]),
  'stale': access([
    kelpieStatus({
      kelpieDevices: [{ ...pairedMac, lastSeenAt: daysAgo(3) }, { ...unpairedIphone, lastSeenAt: daysAgo(3) }],
      observedAt: daysAgo(3),
    }),
  ]),
  'never-heard': access(undefined),
  'named-unreported': access([]),
}

const REVIEW_SCENARIOS: Record<string, {
  change: Record<string, unknown>
  descriptorRevisions: ExecutorDescriptorRevisionView[]
}> = {
  'policy-named': {
    change: { kind: 'descriptor_review', revision: 3, status: 'active' },
    descriptorRevisions: [mcpRevision],
  },
  'policy-none-named': {
    change: { kind: 'descriptor_review', revision: 4, status: 'active' },
    descriptorRevisions: [{
      localPolicyDigest: `sha256:${'d'.repeat(64)}`,
      operationKeys: ['mcp.tools', 'mcp.call'],
      profiles: ['connected_browser'],
      reviewStatus: 'pending_review',
      revision: 4,
    }],
  },
}

/**
 * The whole-suite grant, which is the one prepared change whose JSON tells a
 * person nothing: it names an agent and a state and no operation at all,
 * because the set is derived from the reviewed revision when it is applied.
 * The confirmation therefore has to name the agent and list what it is about
 * to be able to run, and that is what this scenario renders.
 */
const suiteRevision: ExecutorDescriptorRevisionView = {
  commandAllowlist: ['git'],
  localPolicyDigest: `sha256:${'c'.repeat(64)}`,
  operationKeys: [
    'file.list', 'file.read', 'file.write', 'command.run',
    'workspace.review', 'workspace.promote',
  ],
  profiles: ['workspace_sandbox'],
  reviewStatus: 'active',
  revision: 5,
}

const GRANT_AGENT_ID = '00000000-0000-4000-8000-0000000000c1'

const unavailable = async () => { throw new Error('unexpected API call') }
// Only the grant scenario reads through the client, and only the two reads
// its confirmation needs: the executor's access view for the active revision,
// and the agent list for the name. Everything else still refuses, so a
// component that started fetching would fail loudly rather than silently.
const client = {
  delete: unavailable,
  get: async (path: string) => {
    if (path === `/api/executors/${EXECUTOR_ID}/access`) {
      return access(undefined, [suiteRevision])
    }
    if (path.startsWith('/api/agents')) {
      return [{ id: GRANT_AGENT_ID, name: 'Repo Researcher', visibility: 'team' }]
    }
    return unavailable()
  },
  patch: unavailable,
  post: unavailable,
  put: unavailable,
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const scenarioName = new URLSearchParams(window.location.search).get('scenario') ?? 'available'
const grantingWholeSuite = scenarioName === 'whole-suite-grant'
const review = REVIEW_SCENARIOS[scenarioName]
const view = scenarios[scenarioName]

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/executors?tab=permissions']}>
        <div style={{ background: 'var(--bg)', minHeight: '100vh', padding: '24px' }}>
          <div style={{ margin: '0 auto', maxWidth: '720px' }}>
            {grantingWholeSuite ? (
              <div className="admin-card grid gap-3 p-4">
                <h2 className="text-sm font-semibold text-[color:var(--tx)]">
                  Review prepared executor change
                </h2>
                <ExecutorGrantedSuite
                  change={{
                    kind: 'agent_executor_grant',
                    agentId: GRANT_AGENT_ID,
                    state: 'allowed',
                  }}
                  executorId={EXECUTOR_ID}
                />
              </div>
            ) : review ? (
              <div className="admin-card grid gap-3 p-4">
                <h2 className="text-sm font-semibold text-[color:var(--tx)]">
                  Review prepared executor change
                </h2>
                <ExecutorReviewedPolicy
                  change={review.change}
                  descriptorRevisions={review.descriptorRevisions}
                />
              </div>
            ) : view ? (
              <ExecutorDetailPanels
                // The panel takes the *query*, not the view, so it can say
                // when the access view could not be read rather than render a
                // failed fetch as a finding. These scenarios are all the
                // settled, successful state — the refusal has its own unit
                // test in `executor-access-panel-error.test.ts`.
                accessQuery={{
                  data: view,
                  error: null,
                  isError: false,
                  isLoading: false,
                  refetch: () => undefined,
                } as never}
                executor={executor}
                onPrepared={() => undefined}
              />
            ) : (
              <p>Unknown scenario: {scenarioName}</p>
            )}
          </div>
        </div>
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>,
)
