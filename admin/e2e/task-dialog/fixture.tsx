import { ApiClientError, ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type {
  TaskAttachmentRecord,
  TaskCommentRecord,
  TaskLabelRecord,
  TaskRecord,
} from '@nessie/schemas'

import { KanbanCard } from '../../src/components/features/projects/kanban/KanbanCard'
import { TaskDialog } from '../../src/components/features/projects/kanban/TaskDialog'
import { LocalBackProvider, useLocalBackSnapshot } from '../../src/navigation/LocalBackContext'
import { BoardSettingsPage } from '../../src/pages/project/BoardSettingsPage'
import { AgentIdentityProvider } from '../../src/providers/AgentIdentityProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'
import { ticketWorkFor as ticketWorkForState } from './ticket-work'

/**
 * The ticket dialog over a stubbed API (docs/plans/2026-09-21-ticket-comments-
 * attachments-labels/delivery.md §6.5).
 *
 * The real `TaskDialog`, `KanbanCard` and `BoardSettingsPage` render; only
 * the transport is fake, so what a screenshot shows is what a person gets. The
 * scenario is chosen with `?scenario=`: `details` (a Linear-mirrored ticket,
 * read & write, with every kind of comment and file, one of them removed),
 * `mirrored-readonly`, `viewer` (`viewerCanEdit: false`), `create`, `settings`
 * (Board → Settings → Labels) and `card`. `&work=` gives the ticket an agent's
 * work (`ticketWorkFor`): the chip in the dialog and the dot on the card, in
 * each state T1 can reach. Bytes (`/api/attachments/…`,
 * `/api/uploads`) and the session (`/api/auth/me`) are answered by the
 * runner's `page.route`, because they leave through `fetch`/XHR, not the
 * ApiClient.
 *
 * Labels belong to a board: the ticket's board (the project's default) has
 * seven, a second board has two of its own, and only the first seven may ever
 * reach the ticket's field.
 */

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'details'
const theme = params.get('theme')
if (theme) document.documentElement.dataset.theme = theme
try {
  window.localStorage.clear()
  window.sessionStorage.clear()
} catch {
  // A draft left by a previous run would change what the dialog shows.
}
if (scenario === 'settings') {
  // Board settings gates its controls on the session: a stored token makes
  // the provider restore one, and the runner answers `/api/auth/me` as an
  // organisation owner.
  try {
    window.localStorage.setItem('nessie.admin.token', 'task-dialog-fixture')
  } catch {
    // Without storage the page renders read-only and the settings proof says so.
  }
}

const ORG = '10000000-0000-4000-8000-000000000001'
const PROJECT = '10000000-0000-4000-8000-000000000002' as TaskLabelRecord['projectId']
const BOARD = '10000000-0000-4000-8000-000000000003'
const OTHER_BOARD = '10000000-0000-4000-8000-000000000008'
const COLUMN_TODO = '10000000-0000-4000-8000-000000000004'
const COLUMN_DOING = '10000000-0000-4000-8000-000000000005'
const TASK = '10000000-0000-4000-8000-000000000006' as TaskRecord['id']
const SOURCE = '10000000-0000-4000-8000-000000000007'
const PERSON = '20000000-0000-4000-8000-000000000001' as NonNullable<TaskRecord['assigneeUserId']>
const COLLEAGUE = '20000000-0000-4000-8000-000000000002'
const AGENT = '30000000-0000-4000-8000-000000000001' as NonNullable<TaskRecord['assigneeAgentId']>
const IMAGE_ID = '40000000-0000-4000-8000-000000000001'
const PDF_ID = '40000000-0000-4000-8000-000000000002'
const LINK_ID = '40000000-0000-4000-8000-000000000003'
const FAILED_ID = '40000000-0000-4000-8000-000000000004'
const REMOVED_ID = '40000000-0000-4000-8000-000000000005'
const COMMENT_IMAGE_ID = '40000000-0000-4000-8000-000000000006'
const T0 = '2026-09-20T09:00:00.000Z'
type RemoverId = NonNullable<NonNullable<TaskAttachmentRecord['removed']>['byUserId']>

const mirrored = scenario === 'details' || scenario === 'mirrored-readonly'
const writeMode = scenario === 'mirrored-readonly' ? 'read_only' : 'read_write'

const label = (n: number, name: string, color: string, external = false, boardId = BOARD): TaskLabelRecord => ({
  boardId,
  color,
  createdAt: T0,
  external,
  id: `50000000-0000-4000-8000-00000000000${n}`,
  name,
  projectId: PROJECT,
  source: external ? { externalId: `lin-${n}`, provider: 'linear', sourceId: SOURCE } : null,
  taskCount: [12, 3, 1, 0, 5, 2, 0][n - 1] ?? 0,
  updatedAt: T0,
})

// Settings shows the source-owned case too: the name is Linear's, the colour Nessie's.
const sourceOwned = mirrored || scenario === 'settings'
let labels: TaskLabelRecord[] = [
  label(1, 'Bug', '#ef4444', sourceOwned),
  label(2, 'Frontend', '#3b82f6', sourceOwned),
  label(3, 'Performance', '#f97316'),
  label(4, 'Design', '#8b5cf6'),
  label(5, 'Backend', '#22c55e'),
  label(6, 'Needs review', '#eab308'),
  label(7, 'Customer', '#ec4899'),
]
// Another board's vocabulary: listed project-wide, never on this ticket.
const otherBoardLabels: TaskLabelRecord[] = [
  label(8, 'Research', '#14b8a6', false, OTHER_BOARD),
  label(9, 'Interview', '#64748b', false, OTHER_BOARD),
]
const summary = (record: TaskLabelRecord) =>
  ({ color: record.color, external: record.external, id: record.id, name: record.name })

const task: TaskRecord = {
  agentId: null,
  archivedAt: null,
  assigneeAgentId: null,
  assigneeName: 'Jana Nováková',
  assigneeUserId: COLLEAGUE,
  attachmentCount: 3,
  boardId: BOARD,
  commentCount: 3,
  createdAt: T0,
  createdByUserId: PERSON,
  detail: [
    '## Checkout slows down on large carts',
    '',
    'Carts with more than 50 lines take **8 seconds** to render. Steps:',
    '',
    '- Add 60 items to the cart',
    '- Open the checkout',
    '- Watch the spinner',
    '',
    `![profile](/api/attachments/${IMAGE_ID})`,
  ].join('\n'),
  dueDate: '2026-10-02T00:00:00.000Z',
  externalLink: mirrored
    ? {
        externalKey: 'ENG-142',
        externalUrl: 'https://linear.app/acme/issue/ENG-142',
        lastInboundAt: T0,
        provider: 'linear',
        remoteAssigneeDisplay: null,
        remoteAssigneeExternalId: null,
        remoteStateName: 'In Progress',
        sourceId: SOURCE,
        writeMode,
      }
    : null,
  fieldValues: {},
  id: TASK,
  iterationId: null,
  labels: labels.slice(0, 4).map(summary),
  organizationId: ORG,
  ownerName: null,
  ownerUserId: null,
  parentTaskId: null,
  priority: 'high',
  projectId: PROJECT,
  purpose: 'Large carts render slowly at checkout.',
  runId: null,
  status: 'in_progress',
  storyPoints: null,
  title: 'Speed up checkout for large carts',
  updatedAt: T0,
  viewerCanEdit: scenario !== 'viewer',
} as unknown as TaskRecord

const attachment = (
  id: string,
  filename: string,
  mime: string,
  extra: Partial<TaskAttachmentRecord> = {},
): TaskAttachmentRecord => ({
  commentId: null,
  createdAt: T0,
  downloadPath: `/api/attachments/${id}`,
  external: null,
  filename,
  hasThumbnail: false,
  height: null,
  id,
  inline: false,
  kind: mime.startsWith('image/') ? 'image' : 'file',
  mime,
  removed: null,
  sizeBytes: '48213',
  taskId: TASK,
  thumbnailPath: null,
  uploaderUserId: PERSON,
  width: null,
  ...extra,
})

let attachments: TaskAttachmentRecord[] = [
  attachment(IMAGE_ID, 'profile.png', 'image/png', {
    hasThumbnail: true, height: 180, inline: true, sizeBytes: '184320',
    thumbnailPath: `/api/attachments/${IMAGE_ID}/thumbnail`, width: 320,
  }),
  attachment(LINK_ID, 'Design spec', 'text/uri-list', {
    downloadPath: 'https://www.figma.com/file/abc/checkout',
    external: {
      externalUrl: 'https://www.figma.com/file/abc/checkout', provider: 'linear', sourceId: SOURCE,
      status: 'link', title: 'Checkout redesign — Figma',
    },
    sizeBytes: '0', uploaderUserId: null,
  }),
  attachment(FAILED_ID, 'trace.har', 'application/json', {
    downloadPath: 'https://uploads.linear.app/abc/trace.har',
    external: {
      externalUrl: 'https://uploads.linear.app/abc/trace.har', provider: 'linear', sourceId: SOURCE,
      status: 'failed', title: 'trace.har',
    },
    sizeBytes: '0', uploaderUserId: null,
  }),
]
if (!mirrored) attachments = [attachments[0]!, attachment(PDF_ID, 'requirements.pdf', 'application/pdf')]
// A file a colleague marked removed two hours ago, with a reason: still here,
// still downloadable, and not counted on the card.
attachments = [
  ...attachments,
  attachment(REMOVED_ID, 'checkout-v1.pdf', 'application/pdf', {
    createdAt: '2026-09-19T15:00:00.000Z',
    removed: {
      at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      byAgentId: null,
      byUserId: COLLEAGUE as RemoverId,
      reason: 'Superseded by v2',
    },
    sizeBytes: '96256',
  }),
]

const comment = (n: number, author: TaskCommentRecord['author'], body: string, extra: Partial<TaskCommentRecord> = {}) =>
  ({
    attachments: [],
    author,
    body,
    createdAt: `2026-09-20T1${n}:00:00.000Z`,
    editedAt: null,
    external: null,
    id: `60000000-0000-4000-8000-00000000000${n}`,
    taskId: TASK,
    updatedAt: T0,
    viewerCanDelete: false,
    viewerCanEdit: false,
    ...extra,
  }) as TaskCommentRecord

let comments: TaskCommentRecord[] = [
  comment(1, { displayName: 'Petr Linear', externalUserId: 'lin-user-1', kind: 'external', provider: 'linear' },
    'Reproduced on staging. The cart API returns in 200 ms, so it is the render.', {
      external: { externalId: 'c-1', provider: 'linear', sourceId: SOURCE, url: 'https://linear.app/acme/issue/ENG-142#comment-1' },
    }),
  comment(2, { kind: 'agent', agentId: AGENT },
    'I profiled the checkout: `CartLine` re-renders **60×** per keystroke. Memoising it should fix most of it.'),
  comment(3, { kind: 'user', userId: PERSON }, 'Thanks — I will take the memoisation.', {
    editedAt: '2026-09-20T13:05:00.000Z',
    external: mirrored ? { externalId: 'c-3', provider: 'linear', sourceId: SOURCE, url: null } : null,
    viewerCanDelete: scenario !== 'viewer',
    viewerCanEdit: scenario !== 'viewer',
  }),
]
if (scenario === 'details') {
  // One comment of the viewer's own that stays in Nessie.
  comments[2] = { ...comments[2]!, external: null }
}
if (scenario === 'viewer-back') {
  // A comment that carries a picture, so the viewer can be opened from both of
  // the dialog's owners of it: the Attachments list and a comment's files.
  comments[1] = {
    ...comments[1]!,
    attachments: [attachment(COMMENT_IMAGE_ID, 'render-trace.png', 'image/png', {
      commentId: comments[1]!.id, hasThumbnail: true, height: 180, sizeBytes: '65536',
      thumbnailPath: `/api/attachments/${COMMENT_IMAGE_ID}/thumbnail`, width: 320,
    })],
  }
}

// An agent's work on the ticket in the state `&work=` names (`ticket-work.ts`).
const WORK_STATE = params.get('work')
const ticketWorkFor = (state: string | null) => ticketWorkForState(state, AGENT)
const cardWork = WORK_STATE && WORK_STATE !== 'skipped'
  ? (() => {
      const record = ticketWorkFor(WORK_STATE).records[0]!
      return { agentId: AGENT, agentName: 'Perf agent', stateReason: record.stateReason, status: record.status, taskId: TASK }
    })()
  : null

const calls: { body?: unknown; method: string; path: string }[] = []
Object.assign(window, { taskDialogCalls: calls })

const users = [
  { displayName: 'Ondřej Rafaj', email: 'ondrej@example.test', id: PERSON },
  { displayName: 'Jana Nováková', email: 'jana@example.test', id: COLLEAGUE },
]
const agents = [{
  id: AGENT, lastActivityAt: T0, name: 'Perf agent', role: 'performance investigator',
  status: 'idle', systemManaged: false, visibility: 'team',
}]
const board = {
  columns: [
    { color: null, id: COLUMN_TODO, name: 'To do', position: 0, statuses: ['inbox'] },
    { color: null, id: COLUMN_DOING, name: 'In progress', position: 1, statuses: ['in_progress'] },
  ],
  filter: {}, iconEmoji: null, id: BOARD, isDefault: true, name: 'Engineering', position: 0,
  projectId: PROJECT, style: 'cards',
}
const otherBoard = {
  ...board, columns: [], id: OTHER_BOARD, isDefault: false, name: 'Research', position: 1,
}

const get = async (path: string) => {
  calls.push({ method: 'GET', path })
  const url = new URL(path, location.origin)
  const route = url.pathname
  if (params.get('fail') === route) throw new ApiClientError('Unavailable', 'INTERNAL', 500)
  if (route === '/api/users' || route === '/api/tasks/assignees') return users
  if (route === '/api/agents') return agents
  if (route === '/api/personal-assistant') return null
  if (route === '/api/projects') return [{ id: PROJECT, memberCount: 2, name: 'Checkout', organizationId: ORG }]
  if (route === `/api/projects/${PROJECT}/fields`) return []
  if (route === `/api/projects/${PROJECT}/boards`) return [board, otherBoard]
  if (route === `/api/projects/${PROJECT}/labels`) return { labels: [...labels, ...otherBoardLabels] }
  if (route === `/api/projects/${PROJECT}/boards/${BOARD}/labels`) return { labels }
  if (route === `/api/projects/${PROJECT}/boards/${OTHER_BOARD}/labels`) return { labels: otherBoardLabels }
  if (route === `/api/projects/${PROJECT}/sources`) return []
  if (route === `/api/projects/${PROJECT}/sources/${SOURCE}`) {
    return { connectionOwnerDisplayName: 'Ondřej Rafaj', id: SOURCE, provider: 'linear', writeMode }
  }
  if (route === `/api/tasks/${TASK}/comments`) return { comments, nextCursor: null, total: comments.length }
  if (route === `/api/tasks/${TASK}/attachments`) return { attachments }
  if (route === `/api/knowledge-base/tasks/${TASK}/pages`) {
    return [
      { id: '70000000-0000-4000-8000-000000000001', kind: 'note', spaceId: '70000000-0000-4000-8000-000000000009',
        status: 'draft', title: 'Profiling notes' },
    ]
  }
  if (route === `/api/tasks/${TASK}/checklist`) return { steps: [] }
  if (route === `/api/tasks/${TASK}/work`) return ticketWorkFor(WORK_STATE)
  return []
}

const now = () => new Date().toISOString()
const mutate = (method: string) => async (path: string, body?: Record<string, unknown>) => {
  calls.push({ body, method, path })
  const route = new URL(path, location.origin).pathname
  if (method === 'POST' && route === `/api/projects/${PROJECT}/boards/${BOARD}/labels`) {
    const name = String(body?.name)
    const existing = labels.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      throw new ApiClientError('A label with this name exists', 'LABEL_NAME_TAKEN', 409, { label: existing })
    }
    const created: TaskLabelRecord = {
      boardId: BOARD, color: String(body?.color ?? '#6b7280'), createdAt: now(), external: false,
      id: `50000000-0000-4000-8000-0000000001${String(labels.length).padStart(2, '0')}`,
      name, projectId: PROJECT, source: null, taskCount: 0, updatedAt: now(),
    }
    labels = [...labels, created]
    return created
  }
  const labelMatch = new RegExp(`^/api/projects/${PROJECT}/boards/${BOARD}/labels/([^/]+)$`).exec(route)
  if (labelMatch) {
    if (method === 'DELETE') {
      labels = labels.filter((entry) => entry.id !== labelMatch[1])
      return null
    }
    labels = labels.map((entry) => (entry.id === labelMatch[1] ? { ...entry, ...body, updatedAt: now() } : entry))
    return labels.find((entry) => entry.id === labelMatch[1])
  }
  if (method === 'POST' && route === `/api/tasks/${TASK}/comments`) {
    const created = comment(9, { kind: 'user', userId: PERSON }, String(body?.body), {
      createdAt: now(), viewerCanDelete: true, viewerCanEdit: true,
    })
    comments = [...comments, created]
    return created
  }
  const commentMatch = /^\/api\/tasks\/[^/]+\/comments\/([^/]+)$/.exec(route)
  if (commentMatch) {
    if (method === 'DELETE') {
      comments = comments.filter((entry) => entry.id !== commentMatch[1])
      return null
    }
    comments = comments.map((entry) =>
      entry.id === commentMatch[1] ? { ...entry, body: String(body?.body), editedAt: now() } : entry)
    return comments.find((entry) => entry.id === commentMatch[1])
  }
  if (method === 'POST' && route === `/api/tasks/${TASK}/attachments`) {
    const ids = (body?.attachmentIds as string[] | undefined) ?? []
    attachments = [
      ...ids.map((id) => attachment(id, `upload-${id.slice(-4)}.txt`, 'text/plain', { createdAt: now() })),
      ...attachments,
    ]
    return { attachments }
  }
  const attachmentMatch = /^\/api\/tasks\/[^/]+\/attachments\/([^/]+)$/.exec(route)
  if (attachmentMatch && method === 'DELETE') {
    // A mark, not a delete: the row stays and answers who removed it and why.
    const target = attachments.find((entry) => entry.id === attachmentMatch[1])
    if (!target) throw new ApiClientError('Not found', 'NOT_FOUND', 404)
    if (target.removed) {
      throw new ApiClientError('That file is already marked as removed.', 'ATTACHMENT_ALREADY_REMOVED', 409)
    }
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : null
    const removed: TaskAttachmentRecord = {
      ...target,
      removed: { at: now(), byAgentId: null, byUserId: PERSON as RemoverId, reason },
    }
    attachments = attachments.map((entry) => (entry.id === target.id ? removed : entry))
    return removed
  }
  if (route === `/api/tasks/${TASK}` || route === '/api/tasks') return { ...task, ...body }
  return { ok: true }
}

const client = {
  delete: mutate('DELETE'),
  get,
  getPage: async (path: string) => ({ data: await get(path), meta: { hasMore: false } }),
  patch: mutate('PATCH'),
  post: mutate('POST'),
  put: mutate('PUT'),
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

/**
 * What the phone header Back does: read the one local Back registry and invoke
 * its active owner. Every overlay registers there with its kind's priority, so
 * the runner can ask who owns Back and press it without a shell around the
 * dialog.
 */
const BackProbe = () => {
  const snapshot = useLocalBackSnapshot()
  const latest = useRef(snapshot)
  latest.current = snapshot
  useEffect(() => {
    Object.assign(window, {
      taskDialogBack: {
        active: () => latest.current?.active?.id ?? null,
        press: () => {
          const owner = latest.current?.active
          owner?.onBack()
          return owner?.id ?? null
        },
      },
    })
  }, [])
  return null
}

const Scenario = () => {
  if (scenario === 'settings') {
    return (
      <Routes>
        <Route element={<BoardSettingsPage />} path="/projects/:projectId/boards/:boardId/settings" />
      </Routes>
    )
  }
  if (scenario === 'card') {
    // Three stored files, one removed: the server's count is of live files.
    const cardTask = {
      ...task,
      attachmentCount: 2,
      commentCount: 4,
      labels: labels.slice(0, 4).map(summary),
    } as TaskRecord
    return (
      <div className="p-6" style={{ width: 320 }}>
        <DndContext>
          <SortableContext items={[TASK]}>
            <KanbanCard
              onOpen={() => {}}
              projectName="Checkout"
              showProject={false}
              task={cardTask}
              work={cardWork as never}
            />
          </SortableContext>
        </DndContext>
      </div>
    )
  }
  return (
    <TaskDialog
      boardId={BOARD}
      onClose={() => {}}
      open
      projectId={PROJECT}
      task={scenario === 'create' ? null : task}
      taskColumnId={scenario === 'create' ? null : COLUMN_DOING}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <AgentIdentityProvider>
          <MemoryRouter
            initialEntries={[scenario === 'settings'
              ? `/projects/${PROJECT}/boards/${BOARD}/settings?tab=labels`
              : `/projects/${PROJECT}/board`]}
          >
            {/* The shell's one Back registry, which every overlay registers with. */}
            <LocalBackProvider>
              <BackProbe />
              <div data-ready="true" style={{ background: 'var(--main)', minHeight: '100vh' }}>
                <Scenario />
              </div>
            </LocalBackProvider>
          </MemoryRouter>
        </AgentIdentityProvider>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
