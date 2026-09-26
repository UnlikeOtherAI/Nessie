import { ApiClientProvider, createApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { ChannelComposer } from '../../src/components/features/channels/ChannelComposer'
import type { ComposerAttachments } from '../../src/components/features/channels/useComposerAttachments'
import { ExecutorLeaseIndicator } from '../../src/components/features/executors/ExecutorLeaseIndicator'
import type { MentionInputHandle } from '../../src/components/shared/MentionInput'
import { SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_FULL_SCREEN_MAX_WIDTH } from '../../src/hooks/useSidePanelGeometry'
import type { AgentRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { ExecutorDetailContent } from '../../src/pages/ExecutorDetailPage'
import { useExecutorRunLauncher } from '../../src/pages/channels/useExecutorRunLauncher'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * The executor conversation lease's surfaces, drawn by the real components
 * over the real facade hooks, with every API answer supplied by the runner
 * (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §4). No
 * database: who holds a lease is the server's decision, which the API route
 * tests own, so here the holder and another member differ only in what
 * `GET /api/executor-leases` answers them.
 *
 * - `?view=composer` — the main composer, with Run on executor and whatever
 *   lease indicator the launcher hook hands it, exactly as a conversation
 *   wires it.
 * - `?view=reply&root=<messageId>` — a reply panel's composer: no Run on
 *   executor, and the indicator scoped to that reply thread's root, exactly
 *   as `ThreadReplyPanel` wires it.
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

type FixtureComposerProps = {
  executorLeaseIndicator: ReactNode
  message: string
  onChangeMessage: (message: string) => void
  onOpenExecutorRun?: () => void
  placeholder: string
}

/** The one composer, with everything but its toolbar's lease wiring stubbed. */
const FixtureComposer = ({
  executorLeaseIndicator, message, onChangeMessage, onOpenExecutorRun, placeholder,
}: FixtureComposerProps) => {
  const mentionRef = useRef<MentionInputHandle | null>(null)
  return (
    <ChannelComposer
      attachments={noAttachments}
      executorLeaseIndicator={executorLeaseIndicator}
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
      onChangeMessage={onChangeMessage}
      onConfirmSecretCapture={async () => {}}
      onDismissPendingAgent={() => {}}
      onDismissSecretCapture={() => {}}
      onInsertAtSign={() => mentionRef.current?.insertAtSign()}
      onInsertEmoji={() => {}}
      onInsertHashSign={() => mentionRef.current?.insertHashSign()}
      onInvitePendingAgent={() => {}}
      onOpenExecutorRun={onOpenExecutorRun}
      onOversizePaste={() => {}}
      onSubmitForm={(event) => event?.preventDefault()}
      onSubmitText={() => {}}
      pendingAgentInvites={[]}
      placeholder={placeholder}
      secretCapture={null}
      sendError={null}
    />
  )
}

const ComposerView = () => {
  const [message, setMessage] = useState('')
  const launcher = useExecutorRunLauncher({
    agents: AGENTS, message, onLaunched: () => setMessage(''), threadId: THREAD_ID,
  })
  return (
    <div className="flex h-screen flex-col justify-end bg-[color:var(--main)] text-[color:var(--tx)]">
      <FixtureComposer
        executorLeaseIndicator={launcher.leaseIndicator}
        message={message}
        onChangeMessage={setMessage}
        onOpenExecutorRun={launcher.open}
        placeholder="Message #launch"
      />
      {launcher.dialog}
    </div>
  )
}

/**
 * As wide as the reply panel opens on a desktop (`SIDE_PANEL_DEFAULT_WIDTH`),
 * and the whole window below `SIDE_PANEL_FULL_SCREEN_MAX_WIDTH`, where the
 * panel goes full screen. Each runner context has one fixed viewport.
 */
const ReplyView = ({ rootMessageId }: { rootMessageId: string }) => {
  const [message, setMessage] = useState('')
  const width = window.innerWidth < SIDE_PANEL_FULL_SCREEN_MAX_WIDTH ? window.innerWidth : SIDE_PANEL_DEFAULT_WIDTH
  return (
    <div className="flex h-screen justify-end bg-[color:var(--main)] text-[color:var(--tx)]">
      <aside
        className="flex flex-col justify-end border-l border-[color:var(--sep)]"
        data-testid="reply-panel"
        style={{ width }}
      >
        <FixtureComposer
          executorLeaseIndicator={
            <ExecutorLeaseIndicator agents={AGENTS} rootMessageId={rootMessageId} threadId={THREAD_ID} />
          }
          message={message}
          onChangeMessage={setMessage}
          placeholder="Reply to thread"
        />
      </aside>
    </div>
  )
}

const ExecutorView = () => (
  <main className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
    <Routes>
      <Route path="/admin/computers/:executorId" element={<ExecutorDetailContent token={null} />} />
    </Routes>
  </main>
)

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'composer'
const client = createApiClient({ baseUrl: '', token: 'executor-lease-fixture' })
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Executor lease fixture root is missing.')
createRoot(root).render(
  <QueryClientProvider client={queries}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={[`/admin/computers/${EXECUTOR_ID}?tab=activity`]}>
          <LocalBackProvider>
            {view === 'executor'
              ? <ExecutorView />
              : view === 'reply'
                ? <ReplyView rootMessageId={params.get('root') ?? ''} />
                : <ComposerView />}
          </LocalBackProvider>
        </MemoryRouter>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
