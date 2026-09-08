import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { createRoot } from 'react-dom/client'

import { DeviceLinkDialog } from '../../src/pages/settings/connections/DeviceLinkDialog'
import '../../src/styles.css'

const client = {
  delete: async () => undefined,
  get: async () => undefined,
  patch: async () => undefined,
  post: async (path: string) => {
    if (path === '/api/model-subscriptions/device/start') {
      return {
        expiresAt: '2026-09-08T12:15:00.000Z',
        intervalMs: 60_000,
        stateToken: 'device-link-verification-state',
        userCode: 'ABCD-1234',
        verificationUri: 'https://auth.openai.com/codex/device',
      }
    }
    if (path === '/api/model-subscriptions/device/poll') {
      return { intervalMs: 60_000, status: 'pending' }
    }
    if (path === '/api/model-subscriptions/device/cancel') return undefined
    throw new Error(`Unexpected POST ${path}`)
  },
  put: async () => undefined,
} as unknown as ApiClient

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Fixture root is missing.')

// Headless Chromium does not expose the clipboard permission a real tap gets.
// The fixture controls that browser boundary so the visual assertion exercises
// the post-copy label without requiring a machine-level permission prompt.
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async () => undefined },
})

createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ApiClientProvider client={client}>
      <main className="min-h-screen bg-[color:var(--main)]" />
      <DeviceLinkDialog
        onClose={() => undefined}
        provider={{
          authStrategy: 'oauth_device',
          displayName: 'ChatGPT Codex',
          key: 'openai_codex',
          models: [{ displayName: 'GPT-5 Codex', model: 'gpt-5-codex' }],
          termsNote: 'Your ChatGPT plan, your terms.',
        }}
      />
    </ApiClientProvider>
  </QueryClientProvider>,
)
