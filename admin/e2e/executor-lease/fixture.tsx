import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { ChannelComposer } from '../../src/components/features/channels/ChannelComposer'
import type { ComposerAttachments } from '../../src/components/features/channels/useComposerAttachments'
import type { MentionInputHandle } from '../../src/components/shared/MentionInput'
import type { AgentRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { ExecutorDetailContent } from '../../src/pages/ExecutorDetailPage'
import { useExecutorRunLauncher } from '../../src/pages/channels/useExecutorRunLauncher'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * The executor conversation lease's two surfaces, drawn by the real
 * components over the real facade hooks, with every API answer supplied by
 * the runner (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md
 * §4). No database: who holds a lease is the server's decision, which the
 * API route tests own, so here the holder and another member differ only in
 * what `GET /api/executor-leases` answers them.
 *
 * - `?view=composer` — the one composer, with Run on executor and whatever
 *   lease indicator the launcher hook hands it, exactly as a conversation
 *   wires it.
 * - `?view=executor` — the machine's detail page on its Activity tab.
 */

const THREAD_ID = '66666666-6666-4666-8666-666666666666'
const EXECUTOR_ID = '33333333-3333-4333-8333-333333333333'
const AGENTS = [
  { id: '77777777-7777-4777-8777-777777777777', name: 'CTO' },
] as unknown as AgentRecord[]

const noAttachments: ComposerAttachments = {
  addFiles: () => {},
  attachmentIds: [],
  clearStaged: () => {},
  error: null,
  isUploading: false,
  removeStaged: () => {},
  restoreStaged: () => {},
  staged: [],
}

const ComposerView = () => {
  const mentionRef = useRef<MentionInputHandle | null>(null)
  const [message, setMessage] = useState('')
  const launcher = useExecutorRunLauncher({
    agents: AGENTS, message, onLaunched: () => setMessage(''), threadId: THREAD_ID,
  })
  return (
    <div className="flex h-screen flex-col justify-end bg-[color:var(--main)] text-[color:var(--tx)]">
      <ChannelComposer
        attachments={noAttachments}
        executorLeaseIndicator={launcher.leaseIndicator}
        inviteErrors={{}}
        invitingAgentId={null}
        isSendPending={false}
        mentionEntities={[]}
        mentionInvite={{
          error: null, onCancel: () => {}, onInviteAndSend: () => {}, onSendWithoutInviting: () => {},
          pending: false, prompt: null,
        }}
        mentionRef={mentionRef}
        message={message}
        onChangeMessage={setMessage}
        onConfirmSecretCapture={async () => {}}
        onDismissPendingAgent={() => {}}
        onDismissSecretCapture={() => {}}
        onInsertAtSign={() => mentionRef.current?.insertAtSign()}
        onInsertEmoji={() => {}}
        onInsertHashSign={() => mentionRef.current?.insertHashSign()}
        onInvitePendingAgent={() => {}}
        onOpenExecutorRun={launcher.open}
        onOversizePaste={() => {}}
        onSubmitForm={(event) => event?.preventDefault()}
        onSubmitText={() => {}}
        pendingAgentInvites={[]}
        placeholder="Message #launch"
        secretCapture={null}
        sendError={null}
      />
      {launcher.dialog}
    </div>
  )
}

const ExecutorView = () => (
  <main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
    <Routes>
      <Route path="/agents/executors/:executorId" element={<ExecutorDetailContent token={null} />} />
    </Routes>
  </main>
)

const view = new URLSearchParams(window.location.search).get('view') ?? 'composer'
const client = createApiClient({ baseUrl: '', token: 'executor-lease-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor lease fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={[`/agents/executors/${EXECUTOR_ID}?tab=activity`]}>
          <LocalBackProvider>
            {view === 'executor' ? <ExecutorView /> : <ComposerView />}
          </LocalBackProvider>
        </MemoryRouter>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
