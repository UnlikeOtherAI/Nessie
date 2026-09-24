import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProjectRecordSchema } from '@nessie/schemas'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { ExecutorPairDialog } from '../../src/components/features/executors/ExecutorPairDialog'
import { ExecutorPairingPendingNotice } from '../../src/components/features/executors/ExecutorPairingPendingNotice'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import '../../src/styles.css'

const projectId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const client = createApiClient({ baseUrl: '', token: 'pairing-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const Fixture = () => {
  const [open, setOpen] = useState(false)
  const [finished, setFinished] = useState(false)
  return (
    <QueryClientProvider client={queries}>
      <ApiClientProvider client={client}>
        <BrowserRouter>
          <LocalBackProvider>
            <main className="min-h-screen bg-[color:var(--bg)] p-8 text-[color:var(--tx)]">
              <h1>Executors</h1>
              {new URLSearchParams(location.search).has('pending') ? <ExecutorPairingPendingNotice /> : null}
              <button className="admin-button admin-button-primary" onClick={() => setOpen(true)} type="button">Pair executor</button>
              {finished ? <p>Executor opened</p> : null}
              <ExecutorPairDialog
                initialAudience={new URLSearchParams(location.search).has('team') ? 'team' : 'personal'}
                fixedProjectId={new URLSearchParams(location.search).has('project') ? projectId : undefined}
                onClose={() => setOpen(false)}
                onFinished={() => { setOpen(false); setFinished(true) }}
                open={open}
                projects={[ProjectRecordSchema.parse({
                  avatarAttachmentId: null, avatarEmoji: null, createdAt: '2026-09-21T00:00:00.000Z',
                  id: projectId, memberCount: 1, name: 'Release work', organizationId,
                })]}
              />
            </main>
          </LocalBackProvider>
        </BrowserRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  )
}

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor pairing fixture root is missing.')
createRoot(root).render(<Fixture />)
