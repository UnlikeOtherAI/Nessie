import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import type { AppSummaryRecord } from '@nessie/schemas'
import { ApiClientProvider } from '@nessie/client-core'
import type { ApiClient } from '@nessie/client-core'

import { AppConnectDialog } from '../../src/components/features/apps/AppConnectDialog'
import '../../src/styles.css'

const app: AppSummaryRecord = {
  aliases: [], appSource: 'nessie', authMethod: 'api_key', categories: [], connectionCount: 0,
  displayName: 'KiloTalk fixture', distribution: 'remote', featured: false, featuredOrder: null,
  iconUrl: null, id: '11111111-1111-1111-1111-111111111111', locked: false,
  managedByIntegration: false, name: 'kilotalk-fixture', primaryCategory: 'development',
  promptCount: null, resourceCount: null, shortDescription: 'Local fixture only', slug: 'kilotalk-fixture',
  state: 'available', tags: [], toolCount: null, trustLevel: 'verified', vendor: 'Nessie',
}

const calls: Array<{ body: unknown; path: string }> = []
declare global {
  interface Window {
    __appConnectScopeFixture: { calls: Array<{ body: unknown; path: string }> }
  }
}
const apiClient = {
  delete: async () => undefined,
  get: async (path: string) => path === '/api/projects'
    ? [{ id: '22222222-2222-2222-2222-222222222222', name: 'Fixture project' }]
    : [],
  patch: async () => undefined,
  post: async (path: string, body: unknown) => {
    calls.push({ body, path })
    return { connectionId: '33333333-3333-3333-3333-333333333333', status: 'needs_secret' }
  },
  put: async () => undefined,
} as unknown as ApiClient

Object.assign(window, { __appConnectScopeFixture: { calls } })

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('App connection fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiClientProvider client={apiClient}>
      <main className="min-h-screen bg-[color:var(--bg)] p-8 text-[color:var(--tx)]">
        <style>{'.tabbar-shell { width: 80px !important; }'}</style>
        <AppConnectDialog app={app} onClose={() => undefined} open />
      </main>
    </ApiClientProvider>
  </QueryClientProvider>,
)
