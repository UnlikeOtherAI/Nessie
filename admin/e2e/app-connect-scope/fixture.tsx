import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { AppConnectionSummaryRecord, AppDetailRecord, AppSummaryRecord } from '@nessie/schemas'
import { ApiClientProvider } from '@nessie/client-core'
import type { ApiClient } from '@nessie/client-core'
import { BrowserRouter } from 'react-router-dom'

import { AppAgentAccessList } from '../../src/components/features/apps/AppAgentAccessList'
import { AppConnectDialog } from '../../src/components/features/apps/AppConnectDialog'
import { AppConnectionsList } from '../../src/components/features/apps/AppConnectionsList'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

const app: AppSummaryRecord = {
  aliases: [], appSource: 'nessie', authMethod: 'api_key', categories: [], connectionCount: 0,
  displayName: 'KiloTalk fixture', distribution: 'remote', featured: false, featuredOrder: null,
  iconUrl: null, id: '11111111-1111-1111-1111-111111111111', locked: false,
  managedByIntegration: false, name: 'kilotalk-fixture', primaryCategory: 'development',
  promptCount: null, resourceCount: null, shortDescription: 'Local fixture only', slug: 'kilotalk-fixture',
  state: 'available', tags: [], toolCount: null, trustLevel: 'verified', vendor: 'Nessie',
}

const pendingConnectionId = '44444444-4444-4444-8444-444444444444'
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const mixedAccessApp: AppDetailRecord = {
  agentsWithAccess: [], aliases: [], appSource: 'nessie', capabilities: { tools: [] },
  categories: ['development'], connectionCount: 2, connections: [
    {
      agentCount: 0, appName: 'kilotalk-fixture', authMethod: 'api_key',
      capabilities: { resources: [], tools: [] }, connectedAt: '2026-09-09T00:00:00.000Z',
      canDisconnect: true, canReconnect: true, canRefreshCapabilities: true,
      displayName: 'Reviewed channel account', errorMessage: null,
      id: '33333333-3333-3333-8333-333333333333', lastConnectedAt: '2026-09-09T00:00:00.000Z',
      scopeId: '55555555-5555-4555-8555-555555555555', scopeType: 'channel', status: 'connected',
    },
    {
      agentCount: 0, appName: 'kilotalk-fixture', authMethod: 'api_key',
      capabilities: { resources: [], tools: [] }, connectedAt: '2026-09-09T00:00:00.000Z',
      canDisconnect: true, canReconnect: true, canRefreshCapabilities: true,
      displayName: 'Waiting project account', errorMessage: null,
      id: pendingConnectionId, lastConnectedAt: '2026-09-09T00:00:00.000Z',
      scopeId: '66666666-6666-4666-8666-666666666666', scopeType: 'project', status: 'connected',
    },
  ],
  displayName: 'KiloTalk fixture', distribution: 'remote', documentationUrl: null, featured: false,
  featuredOrder: null, iconUrl: null, id: app.id, locked: false, longDescription: null,
  managedByIntegration: false, name: app.name, primaryCategory: 'development', promptCount: null,
  repositoryUrl: null, resourceCount: null, shortDescription: app.shortDescription, slug: app.slug,
  state: 'connected', tags: [], toolCount: 3, trustLevel: 'verified', vendor: 'Nessie', websiteUrl: null,
}

const recoveryConnection: AppConnectionSummaryRecord = {
  canDisconnect: false,
  canReconnect: true,
  canRefreshCapabilities: true,
  displayName: 'Expired personal account',
  errorMessage: 'The sign-in for KiloTalk fixture is no longer valid. Reconnect to keep using it.',
  id: '77777777-7777-4777-8777-777777777777',
  lastConnectedAt: null,
  scopeId: '88888888-8888-4888-8888-888888888888',
  scopeType: 'user',
  status: 'expired',
}

const recoveryApp: AppDetailRecord = {
  ...mixedAccessApp,
  connections: [recoveryConnection],
}

const calls: Array<{ body: unknown; path: string }> = []
const policyCalls: string[] = []
declare global {
  interface Window {
    __appConnectScopeFixture: {
      calls: Array<{ body: unknown; path: string }>
      failPolicyPatchAt: number | null
      policyCalls: string[]
      refreshFailure: 'probe' | 'request' | null
    }
  }
}
const apiClient = {
  delete: async () => undefined,
  get: async (path: string) => {
    if (path === '/api/projects') return [{ id: '22222222-2222-2222-2222-222222222222', name: 'Fixture project' }]
    if (path === '/api/mcp/tools') return [
      { enabled: true, id: 'tool-active-a', mcpInstanceId: '33333333-3333-3333-8333-333333333333', policyKey: 'tool-active-a', requiresExplicitGrant: true, status: 'active' },
      { enabled: true, id: 'tool-active-b', mcpInstanceId: '33333333-3333-3333-8333-333333333333', policyKey: 'tool-active-b', requiresExplicitGrant: true, status: 'active' },
      { enabled: true, id: 'tool-active-c', mcpInstanceId: '33333333-3333-3333-8333-333333333333', policyKey: 'tool-active-c', requiresExplicitGrant: true, status: 'active' },
      { enabled: true, id: 'tool-waiting-a', mcpInstanceId: pendingConnectionId, policyKey: 'tool-waiting-a', requiresExplicitGrant: true, status: 'pending_review' },
      { enabled: true, id: 'tool-waiting-b', mcpInstanceId: pendingConnectionId, policyKey: 'tool-waiting-b', requiresExplicitGrant: true, status: 'pending_review' },
    ]
    if (path === '/api/mcp/tools/policy-targets') { policyCalls.push(path); return [{ agentKind: 'shared', id: '99999999-9999-4999-8999-999999999999', name: 'Fixture researcher', role: 'Researcher', toolPolicy: {} }] }
    return []
  },
  patch: async (path: string) => {
    policyCalls.push(path)
    const patchCount = policyCalls.filter((call) => call.includes('/policy-targets/')).length
    if (window.__appConnectScopeFixture.failPolicyPatchAt === patchCount) {
      throw new Error('rate limited')
    }
    return {}
  },
  post: async (path: string, body: unknown) => {
    calls.push({ body, path })
    if (path.endsWith('/refresh-capabilities')) {
      if (window.__appConnectScopeFixture.refreshFailure === 'request') {
        throw new Error('permission revoked')
      }
      if (window.__appConnectScopeFixture.refreshFailure === 'probe') {
        return { connectionId: recoveryConnection.id, status: 'error', toolCount: 0 }
      }
      return { connectionId: recoveryConnection.id, status: 'connected', toolCount: 3 }
    }
    return { connectionId: '33333333-3333-3333-3333-333333333333', status: 'needs_secret' }
  },
  put: async () => undefined,
} as unknown as ApiClient

Object.assign(window, { __appConnectScopeFixture: { calls, failPolicyPatchAt: null, policyCalls, refreshFailure: null } })
window.localStorage.setItem('nessie.admin.token', 'app-connect-scope-e2e')
window.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin)
  if (url.pathname === '/api/auth/me') return Response.json({ data: {
    auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local-bootstrap' },
    context: { bootstrapMode: false, organizationId: '77777777-7777-4777-8777-777777777777', projectId: null, teamId: null },
    session: { issuedAt: '2026-09-09T00:00:00.000Z', sessionId: 'app-connect-scope-e2e' },
    user: { displayName: 'Fixture owner', email: 'fixture@example.test', id: '88888888-8888-4888-8888-888888888888', roleIds: ['owner'], superAdmin: false },
  } })
  return Response.json({ data: [] })
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('App connection fixture root is missing.')
const Fixture = () => {
  const [dialogOpen, setDialogOpen] = useState(true)
  const [reconnecting, setReconnecting] = useState<AppConnectionSummaryRecord | null>(null)
  return (
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider><ApiClientProvider client={apiClient}><BrowserRouter>
      <main className="min-h-screen bg-[color:var(--bg)] p-8 text-[color:var(--tx)]">
        <AppConnectDialog
          app={app}
          onClose={() => {
            setDialogOpen(false)
            setReconnecting(null)
          }}
          open={dialogOpen || reconnecting !== null}
          reconnectConnection={reconnecting}
        />
        <section className="mx-auto mt-8 max-w-3xl" aria-label="Mixed review access fixture">
          <AppAgentAccessList app={mixedAccessApp} />
        </section>
        <section className="mx-auto mt-8 max-w-3xl" aria-label="Account recovery fixture">
          <AppConnectionsList
            app={recoveryApp}
            onConnectAnother={() => undefined}
            onReconnect={setReconnecting}
          />
        </section>
      </main>
    </BrowserRouter></ApiClientProvider></AuthSessionProvider>
  </QueryClientProvider>
  )
}
createRoot(root).render(<Fixture />)
