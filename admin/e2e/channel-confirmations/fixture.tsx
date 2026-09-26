import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { AnnouncementConfirmationControl } from '../../src/components/features/channels/AnnouncementConfirmationControl'
import '../../src/styles.css'

const role = new URLSearchParams(window.location.search).get('role')
const isAuthor = role === 'author'
const messageId = '11111111-1111-4111-8111-111111111111'
const writes: string[] = []
const receipt = { eligible: true, seen: false, acknowledged: false }
const status = {
  canRemind: true,
  acknowledged: [{ id: 'one', displayName: 'Ada', seenAt: '2026-09-26T10:00:00Z',
    acknowledgedAt: '2026-09-26T10:01:00Z', reminderSent: false,
    reminderPending: false, reminderError: null }],
  seen: [{ id: 'two', displayName: 'Bo', seenAt: '2026-09-26T10:00:00Z',
    acknowledgedAt: null, reminderSent: false, reminderPending: false, reminderError: null }],
  unseen: [{ id: 'three', displayName: 'Cy', seenAt: null,
    acknowledgedAt: null, reminderSent: false, reminderPending: false, reminderError: null }],
}
const client = {
  get: async (path: string) => path.endsWith('/confirmation-status')
    ? structuredClone(status) : structuredClone(receipt),
  post: async (path: string) => {
    writes.push(path)
    if (path.endsWith('/seen')) receipt.seen = true
    if (path.endsWith('/acknowledge')) {
      receipt.seen = true
      receipt.acknowledged = true
    }
    if (path.endsWith('/remind-unconfirmed')) {
      for (const person of [...status.seen, ...status.unseen]) person.reminderSent = true
      return { queued: 2 }
    }
    return { ok: true }
  },
} as unknown as ApiClient

Object.assign(window, { __confirmationFixture: { writes, receipt, status } })
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ApiClientProvider client={client}>
      <main className="min-h-screen bg-[var(--bg)] p-6 text-[color:var(--tx)]">
        <article className="admin-card max-w-2xl p-5">
          <h1 className="text-lg font-semibold">Team announcement</h1>
          <p className="mt-2">Please read and confirm the new schedule.</p>
          <AnnouncementConfirmationControl messageId={messageId}
            isAuthor={isAuthor} canViewStatus={isAuthor} />
        </article>
      </main>
    </ApiClientProvider>
  </QueryClientProvider>,
)
