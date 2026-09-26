import { ApiClientError, ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

import { KanbanBoard } from '../../src/components/features/projects/kanban/KanbanBoard'
import type { BoardColumnView } from '../../src/components/features/projects/kanban/kanban-config'
import { BoardStartWorkDialog } from '../../src/components/features/ticket-work/BoardStartWorkDialog'
import { TriggerDetail } from '../../src/components/features/triggers/TriggerDetail'
import { TriggerEditorDialog } from '../../src/components/features/triggers/TriggerEditorDialog'
import type { AgentRecord, AgentTriggerRecord, ChannelRecord } from '../../src/lib/api-client'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { DocsScenario, DocumentDetailScenario, documentGet, refuseDocumentCreate } from './documents'
import { machineAccessGet, machineAccessPost, suspendMachineAccess } from './machine-access'
import { installTriggerPageSession, TriggerPageScenario } from './trigger-page'
import { AgentIdentityProvider } from '../../src/providers/AgentIdentityProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * The Triggers editor and the board's ticket-work doorways over a stubbed API
 * (docs/plans/2026-09-23-ticket-driven-agents/verification.md, T0 and T1).
 *
 * The real `TriggerEditorDialog`, `TriggerTypePicker`, `KanbanBoard` and
 * `TriggerDetail` render; only the transport is fake, and every write lands on
 * `window.__agentTriggersFixture` for the runner to read. `?scenario=` picks:
 * `create` (the type picker, and a webhook create), `workflow` (the picker for
 * a workflow target), `ticket` (a ticket trigger refused on a field, then
 * created), `document` (a document trigger refused on its space, then
 * created), `board` (the column badge, card dots and the column menu that
 * opens the editor prefilled), `detail` and `document-detail` (a ticket or
 * document trigger's facts and deliveries; a ticket trigger's Machine access
 * section in the state `&access=` names, from `machine-access.tsx`), `docs` (the project's Documents:
 * review badges, and the row menu's "Tell an agent when this changes…";
 * `&owner=0` for a viewer the Triggers routes refuse) and `page` (the real
 * `TriggerDetailPage` of the ticket trigger, for the `&viewer=` of
 * `trigger-page.tsx`; a save through its editor pauses live machine access).
 * The document half's data and stubs are in `documents.tsx`.
 *
 * The CTO is bound to a public project channel and a protected one; only the
 * public one may carry ticket work. The Review column already starts the
 * Reviewer's work, so picking it too is refused the way the server refuses it.
 */

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'create'
const ORG = '60000000-0000-4000-8000-000000000010'
const AGENT_ID = '60000000-0000-4000-8000-000000000001'
const REVIEWER_ID = '60000000-0000-4000-8000-000000000004'
const CHANNEL_ID = '60000000-0000-4000-8000-000000000002'
const LEADS_ID = '60000000-0000-4000-8000-000000000005'
const PROJECT = '60000000-0000-4000-8000-000000000011'
const BOARD = '60000000-0000-4000-8000-000000000012'
const BACKLOG = '60000000-0000-4000-8000-000000000013'
const DOING = '60000000-0000-4000-8000-000000000014'
const REVIEW = '60000000-0000-4000-8000-000000000015'
const DONE = '60000000-0000-4000-8000-000000000016'
const REVIEW_TRIGGER = '60000000-0000-4000-8000-000000000020'
const TICKET_TRIGGER = '60000000-0000-4000-8000-000000000021'
const T0 = '2026-09-23T09:00:00.000Z'

try {
  window.localStorage.clear()
  window.sessionStorage.clear()
} catch {
  // A draft left by a previous run would change what the dialog shows.
}
if (scenario === 'page') installTriggerPageSession(params.get('viewer') ?? 'owner')

const agents = [
  {
    agentKind: 'shared', channelIds: [LEADS_ID, CHANNEL_ID], id: AGENT_ID, name: 'CTO', role: 'Engineering lead',
    status: 'idle', systemManaged: false, visibility: 'team',
  },
  {
    agentKind: 'shared', channelIds: [CHANNEL_ID], id: REVIEWER_ID, name: 'Reviewer', role: 'Code reviewer',
    status: 'idle', systemManaged: false, visibility: 'team',
  },
] as unknown as AgentRecord[]

const room = (id: string, label: string, visibility: 'public' | 'protected') => ({
  defaultThreadId: `${id.slice(0, -2)}99`, id, label, name: label, organizationId: ORG, projectId: PROJECT,
  projectName: 'Nessie', scope: 'project', teamId: ORG, teamName: 'Engineering', type: 'standard', visibility,
})
// The protected room is listed first: the editor must skip it for ticket work.
const channels = [room(LEADS_ID, 'leads', 'protected'), room(CHANNEL_ID, 'engineering', 'public')] as unknown as ChannelRecord[]

const columns: BoardColumnView[] = [
  { category: 'todo', id: BACKLOG, name: 'Backlog' },
  { category: 'in_progress', id: DOING, name: 'In progress' },
  { category: 'review', id: REVIEW, name: 'Review' },
  { category: 'done', id: DONE, name: 'Done' },
]
const board = {
  columns: columns.map((column, position) => ({ ...column, boardId: BOARD, position, stateBindings: [] })),
  filter: { sources: 'all' }, iconEmoji: null, id: BOARD, isDefault: true, name: 'Engineering', position: 0,
  projectId: PROJECT, style: 'kanban',
}

const task = (n: number, title: string, columnId: string, extra: Record<string, unknown> = {}) => ({
  agentId: null, archivedAt: null, assigneeAgentId: null, assigneeName: null, assigneeUserId: null,
  attachmentCount: 0, boardId: BOARD, columnId, commentCount: 0, createdAt: T0, createdByUserId: null, detail: null,
  dueDate: null, externalLink: null, fieldValues: {}, id: `60000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  iterationId: null, labels: [], organizationId: ORG, ownerName: null, ownerUserId: null, parentTaskId: null,
  position: n, priority: 'medium', projectId: PROJECT, purpose: null, runId: null, status: 'in_progress',
  storyPoints: null, title, updatedAt: T0, viewerCanEdit: true, ...extra,
})
const tasks = [
  task(1, 'Fix login redirect', DOING, { assigneeAgentId: AGENT_ID, assigneeName: 'CTO', commentCount: 2 }),
  task(2, 'Refactor billing', DOING, { assigneeAgentId: AGENT_ID, assigneeName: 'CTO' }),
  task(3, 'Tidy the settings page', REVIEW, { status: 'review' }),
  task(4, 'Write the release notes', BACKLOG, { status: 'inbox' }),
]
const ticketWork = {
  cards: [
    { agentId: AGENT_ID, agentName: 'CTO', stateReason: null, status: 'active', taskId: tasks[0]!.id },
    { agentId: AGENT_ID, agentName: 'CTO', stateReason: 'limit_wakes', status: 'failed', taskId: tasks[1]!.id },
  ],
  pickups: [{ agentId: REVIEWER_ID, agentName: 'Reviewer', columnId: REVIEW, triggerId: REVIEW_TRIGGER }],
  viewerCanCreateTriggers: true,
}

const ticketTrigger = {
  agentId: AGENT_ID, config: {
    boardId: BOARD, endOn: [{ category: 'todo' }, { category: 'done' }],
    follow: { includeSourceEvents: false, kinds: ['comment', 'description', 'moved', 'thread_message', 'document'] },
    instructions: { general: 'Triage every ticket and comment a plan.' }, limits: { startsPerDay: 20, wakesPerTicket: 30 },
    pickup: { assignOnPickup: true, columnIds: [DOING] }, quietWakeMinutes: 30,
  },
  createdAt: T0, description: 'Picks up what people move into In progress.', enabled: true, id: TICKET_TRIGGER,
  lastFiredAt: T0, name: 'Start work from In progress', status: 'active', targetChannelId: CHANNEL_ID,
  type: 'ticket_changed', updatedAt: T0,
} as unknown as AgentTriggerRecord
const NAMES_NO_EVENT = new Set(['reminder', 'quiet', 'session', 'machine_back_online'])
const delivery = (n: number, source: string, status: string, payload: Record<string, unknown>) => ({
  createdAt: `2026-09-23T1${n}:00:00.000Z`, id: `60000000-0000-4000-8000-0000000002${n}0`,
  // A reminder names its reminder, a session its session, a quiet wake and a machine back
  // nothing; every other event its TaskEvent.
  payload: {
    taskId: tasks[0]!.id,
    ...(NAMES_NO_EVENT.has(String(payload.eventType)) || payload.kind === 'standing_policy_refused'
      ? {}
      : { taskEventId: `60000000-0000-4000-8000-0000000003${n}0` }),
    ...payload,
  },
  source, status, triggerId: TICKET_TRIGGER,
  ...(status === 'skipped' ? { errorMessage: String(payload.skipReason ?? 'Ran without a machine.') } : {}),
})
const history = [
  // T5: a close the agent made itself, which woke nobody.
  delivery(9, 'session', 'skipped', {
    eventType: 'session', originKind: 'system', outcome: 'skipped', skipReason: 'no_longer_applies',
    session: { sessionId: '60000000-0000-4000-8000-000000000710', status: 'closed', turn: 4 },
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  // T5: the ticket's machine came back online, and its coding session ended a turn.
  delivery(8, 'machine', 'delivered', {
    eventType: 'machine_back_online', originKind: 'system', outcome: 'follow', wakeReason: 'machine_back_online',
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  delivery(7, 'session', 'delivered', {
    eventType: 'session', originKind: 'system', outcome: 'follow', wakeReason: 'session_turn_ended',
    session: { sessionId: '60000000-0000-4000-8000-000000000710', status: 'waiting_for_input', turn: 3 },
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  // T4: a run the standing-policy binder bound no machine to.
  delivery(6, 'binding', 'skipped', {
    kind: 'standing_policy_refused', reason: 'machine_unavailable', runId: '60000000-0000-4000-8000-000000000700',
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  // T3: the agent's own reminder, and the platform's quiet wake.
  delivery(5, 'quiet', 'delivered', {
    eventType: 'quiet', originKind: 'system', outcome: 'follow', wakeReason: 'quiet', followedWakeAt: T0,
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  delivery(4, 'reminder', 'delivered', {
    eventType: 'reminder', originKind: 'system', outcome: 'follow', wakeReason: 'reminder',
    reminderId: '60000000-0000-4000-8000-000000000500', workId: '60000000-0000-4000-8000-000000000400',
  }),
  delivery(3, 'follow', 'delivered', {
    eventType: 'comment_added', originKind: 'session', outcome: 'follow', wakeReason: 'ticket_commented',
    workId: '60000000-0000-4000-8000-000000000400',
  }),
  delivery(2, 'pickup', 'skipped', {
    eventType: 'column_entered', originKind: 'agent', outcome: 'skipped', skipReason: 'agent_origin',
  }),
  delivery(1, 'pickup', 'delivered', {
    eventType: 'column_entered', originKind: 'session', outcome: 'pickup', wakeReason: 'pickup',
    workId: '60000000-0000-4000-8000-000000000400',
  }),
]

type Posted = { body: unknown; path: string }
// `reads`: every Finder read of document triggers, so the runner can count one per folder.
const fixture = { location: undefined as string | undefined, posted: [] as Posted[], reads: [] as string[] }
;(window as unknown as { __agentTriggersFixture: typeof fixture }).__agentTriggersFixture = fixture

const PICKUP_REFUSAL = 'column "Review" is already a start-work column of the enabled trigger "Review pass" of '
  + `Reviewer (triggerId=${REVIEW_TRIGGER}), and two agents would start on the same ticket. `
  + 'Disable that trigger, or pick another column'

const get = async (path: string) => {
  const url = new URL(path, location.origin)
  const route = url.pathname
  const access = machineAccessGet(url)
  if (access !== undefined) return access
  const documents = documentGet(url, fixture, AGENT_ID)
  if (documents !== undefined) return documents
  if (route === '/api/agents') return agents
  if (route === '/api/channels') return channels
  if (route === `/api/projects/${PROJECT}/boards`) return [board]
  if (route === `/api/projects/${PROJECT}/fields`) return []
  if (route === `/api/triggers/${TICKET_TRIGGER}/history`) return history
  // The trigger's page: an owner reads the list, its author the one trigger.
  if (route === '/api/triggers') return [ticketTrigger]
  if (route === `/api/triggers/${TICKET_TRIGGER}`) return ticketTrigger
  return []
}

/**
 * A save of the ticket trigger: recorded, and answered as the server answers
 * an edit of a pinned field while its machine access is live — paused, and
 * said beside the trigger.
 */
const put = async (path: string, body: unknown) => {
  fixture.posted.push({ body, path })
  if (path !== `/api/triggers/${TICKET_TRIGGER}`) return { ok: true }
  const paused = suspendMachineAccess()
  return {
    ...ticketTrigger,
    ...(paused ? { machineAccess: { authorName: 'Ondrej', fields: ['the general instructions'], kind: 'suspended' } } : {}),
  }
}

const client = {
  delete: async () => ({ ok: true }),
  get,
  getPage: async (path: string) => ({ data: await get(path), meta: { hasMore: false } }),
  patch: async () => ({ ok: true }),
  post: async (path: string, body: { type: AgentTriggerRecord['type'] } & Record<string, unknown>) => {
    // The Machine access section's prepare and End (machine-access.tsx).
    const access = machineAccessPost(path, body, fixture.posted)
    if (access !== undefined) return access
    // Only a trigger create is the runner's business; the docs tab's own writes are not.
    if (!path.endsWith('/triggers')) return { ok: true }
    fixture.posted.push({ body, path })
    refuseDocumentCreate(body as never)
    const pickup = (body.config as { pickup?: { columns?: { id: string }[] } } | undefined)?.pickup
    // What `resolveTicketChangedTrigger` answers for the one-pickup-per-column rule.
    const index = pickup?.columns?.findIndex((column) => column.id === REVIEW) ?? -1
    if (body.type === 'ticket_changed' && index >= 0) {
      const refusal = { path: `pickup.columns[${index}]`, reason: PICKUP_REFUSAL, triggerId: REVIEW_TRIGGER }
      throw new ApiClientError(`${refusal.path}: ${refusal.reason}`, 'TRIGGER_CONFIG_REFUSED', 400, { refusals: [refusal] })
    }
    return {
      ...body, agentId: AGENT_ID, config: body.config ?? {}, createdAt: new Date().toISOString(),
      enabled: body.enabled ?? true, id: '60000000-0000-4000-8000-000000000003', status: 'active',
      updatedAt: new Date().toISOString(),
    } as AgentTriggerRecord
  },
  put,
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const BoardScenario = () => {
  const [column, setColumn] = useState<BoardColumnView | null>(null)
  return (
    <div className="h-screen p-4">
      <KanbanBoard
        boardId={BOARD}
        columns={columns}
        onMoveTask={() => {}}
        onOpenTask={() => {}}
        onStartWork={setColumn}
        projectId={PROJECT}
        projectNameById={{ [PROJECT]: 'Nessie' }}
        showProject={false}
        tasks={tasks as never}
        ticketWork={ticketWork as never}
      />
      {column ? (
        <BoardStartWorkDialog boardId={BOARD} column={column} onClose={() => setColumn(null)} projectId={PROJECT} />
      ) : null}
    </div>
  )
}

// `workflow`: the editor opens on a workflow target, which can hold neither agent-only type.
const workflowInstallations = scenario === 'workflow'
  ? [{ id: '60000000-0000-4000-8000-000000000040', status: 'active', workflowTemplateId: 'tpl' }] as never[]
  : []
const workflowTemplates = scenario === 'workflow' ? [{ id: 'tpl', name: 'Nightly digest' }] as never[] : []

const Scenario = () => {
  const [open, setOpen] = useState(true)
  if (scenario === 'board') return <BoardScenario />
  if (scenario === 'docs') return <DocsScenario state={fixture} />
  if (scenario === 'document-detail') return <DocumentDetailScenario agents={agents} channels={channels} />
  if (scenario === 'detail') {
    return (
      <div className="p-6">
        <TriggerDetail
          registry={{
            agentsById: new Map(agents.map((agent) => [agent.id, agent])),
            channelsById: new Map(channels.map((channel) => [channel.id, channel])),
            workflowInstallationsById: new Map(),
            workflowTemplatesById: new Map(),
          }}
          trigger={ticketTrigger}
        />
      </div>
    )
  }
  return (
    <TriggerEditorDialog
      agents={agents}
      channels={channels}
      onClose={() => setOpen(false)}
      onSaved={() => {}}
      open={open}
      workflowInstallations={workflowInstallations}
      workflowTemplates={workflowTemplates}
    />
  )
}

const framed = (body: ReactNode) => (
  // The shell's one Back registry, which the dialog registers with.
  <LocalBackProvider>
    <div data-ready="true" style={{ background: 'var(--main)', minHeight: '100vh' }}>{body}</div>
  </LocalBackProvider>
)

// A data router, because the docs tab's upload guard blocks navigation (`useBlocker`).
const router = createMemoryRouter([
  // The trigger's own page reads its id from the route, as the admin's router gives it.
  ...(scenario === 'page' ? [{ element: framed(<TriggerPageScenario />), path: '/admin/automations/triggers/:triggerId' }] : []),
  { element: framed(<Scenario />), path: '*' },
], {
  // `&view=list` opens the docs tab in the Finder's list view.
  initialEntries: [scenario === 'docs'
    ? `/projects/${PROJECT}/docs${params.get('view') ? `?view=${params.get('view')}` : ''}`
    : scenario === 'page' ? `/admin/automations/triggers/${TICKET_TRIGGER}` : '/admin/automations?tab=triggers'],
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <AgentIdentityProvider>
          <RouterProvider router={router} />
        </AgentIdentityProvider>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
