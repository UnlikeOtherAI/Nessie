import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutlet,
  useSearchParams,
} from 'react-router-dom'
import type { TaskLabelRecord, TaskRecord } from '@nessie/schemas'

import { TaskDialog } from '../../src/components/features/projects/kanban/TaskDialog'
import { Dialog } from '../../src/components/shared/Dialog'
import { useProjectBoards } from '../../src/facades/boards/hooks'
import { useProjects } from '../../src/facades/projects/hooks'
import { PhoneNavigationProvider, usePhoneNavigation } from '../../src/layouts/admin-shell/PhoneNavigationProvider'
import { PhoneNavigationViewport } from '../../src/layouts/admin-shell/PhoneNavigationViewport'
import { LocalBackProvider } from '../../src/navigation/LocalBackContext'
import { useNavigationLayout } from '../../src/navigation/mobile-shell'
import { NestedStage } from '../../src/navigation/NestedStage'
import { BoardSettingsPage } from '../../src/pages/project/BoardSettingsPage'
import { AgentIdentityProvider } from '../../src/providers/AgentIdentityProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

/**
 * An overlay follows the screen it was opened from (docs/navigation/overlays.md,
 * "An overlay belongs to its layer").
 *
 * The real navigation stack — `LocalBackProvider`, `PhoneNavigationProvider`
 * and `PhoneNavigationViewport` composed the way `AdminShellLayout` composes
 * them, `split` on a desktop and `single` on a phone — over a stubbed
 * ApiClient. The board route opens the real `TaskDialog` from `?task=`, and
 * the Knowledge-style route hosts a real `NestedStage` with a real `Dialog`
 * inside it. Each dialog carries one fixture doorway, portalled into its own
 * panel, that pushes Board → Settings (a `nested` surface) *without* closing
 * the dialog: the case no product doorway reaches today, and the one where a
 * dialog used to stay painted, focus-trapped and first for Back over the
 * screen pushed on top of it.
 *
 * `window.overlayLayerFixture` exposes the one navigation controller, so the
 * runner can ask the Back resolver what Back would do and press the history
 * control the desktop top bar uses.
 */

const params = new URLSearchParams(location.search)
const start = params.get('start') ?? 'board'
try {
  window.localStorage.clear()
  window.sessionStorage.clear()
} catch {
  // A draft left by a previous run would change what the dialog shows.
}

const ORG = '10000000-0000-4000-8000-000000000001'
const PROJECT = '10000000-0000-4000-8000-000000000002'
const BOARD = '10000000-0000-4000-8000-000000000003'
const COLUMN = '10000000-0000-4000-8000-000000000004'
const TASK = '10000000-0000-4000-8000-000000000006'
const PERSON = '20000000-0000-4000-8000-000000000001'
const T0 = '2026-09-20T09:00:00.000Z'
const SETTINGS = `/projects/${PROJECT}/boards/${BOARD}/settings?tab=labels`

// The fixture's own document is the stack's first route. Replaced before the
// router mounts, so the router starts there and browser Back never leaves it.
window.history.replaceState(null, '', start === 'stage' ? `/projects/${PROJECT}/docs` : `/projects/${PROJECT}/board`)

const labels: TaskLabelRecord[] = [
  {
    boardId: BOARD, color: '#ef4444', createdAt: T0, external: false,
    id: '50000000-0000-4000-8000-000000000001', name: 'Bug',
    projectId: PROJECT as TaskLabelRecord['projectId'], source: null, taskCount: 1, updatedAt: T0,
  },
]

const task = {
  agentId: null, archivedAt: null, assigneeAgentId: null, assigneeName: null, assigneeUserId: null,
  attachmentCount: 0, boardId: BOARD, commentCount: 0, createdAt: T0, createdByUserId: PERSON,
  detail: 'Carts with more than 50 lines take **8 seconds** to render.',
  dueDate: null, externalLink: null, fieldValues: {}, id: TASK, iterationId: null,
  labels: [{ color: '#ef4444', external: false, id: labels[0]!.id, name: 'Bug' }],
  organizationId: ORG, ownerName: null, ownerUserId: null, parentTaskId: null, priority: 'high',
  projectId: PROJECT, purpose: 'Large carts render slowly at checkout.', runId: null,
  status: 'in_progress', storyPoints: null, title: 'Speed up checkout for large carts',
  updatedAt: T0, viewerCanEdit: true,
} as unknown as TaskRecord

const board = {
  columns: [{ color: null, id: COLUMN, name: 'In progress', position: 0, statuses: ['in_progress'] }],
  filter: {}, iconEmoji: null, id: BOARD, isDefault: true, name: 'Engineering', position: 0,
  projectId: PROJECT, style: 'cards',
}

const get = async (path: string) => {
  const route = new URL(path, location.origin).pathname
  if (route === '/api/users' || route === '/api/tasks/assignees') {
    return [{ displayName: 'Ondřej Rafaj', email: 'ondrej@example.test', id: PERSON }]
  }
  if (route === '/api/personal-assistant') return null
  if (route === '/api/projects') return [{ id: PROJECT, memberCount: 1, name: 'Checkout', organizationId: ORG }]
  if (route === `/api/projects/${PROJECT}/boards`) return [board]
  if (route === `/api/projects/${PROJECT}/labels`) return { labels }
  if (route === `/api/projects/${PROJECT}/boards/${BOARD}/labels`) return { labels }
  if (route === `/api/tasks/${TASK}/comments`) return { comments: [], nextCursor: null, total: 0 }
  if (route === `/api/tasks/${TASK}/attachments`) return { attachments: [] }
  if (route === `/api/tasks/${TASK}/checklist`) return { steps: [] }
  // No agent works this ticket: the dialog's work chip reads this and draws nothing.
  if (route === `/api/tasks/${TASK}/work`) return { lastSkip: null, records: [] }
  return []
}

const client = {
  delete: async () => null,
  get,
  getPage: async (path: string) => ({ data: await get(path), meta: { hasMore: false } }),
  patch: async () => ({ ok: true }),
  post: async () => ({ ok: true }),
  put: async () => ({ ok: true }),
} as unknown as ApiClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

// Every close the dialogs ask for, so the runner can prove Escape and Back on
// the pushed screen never reached the dialog beneath it.
const closes: string[] = []

/**
 * A doorway inside a dialog's own panel: rendered from the page, portalled
 * into the panel, so it takes part in the dialog's focus trap exactly like
 * one of the dialog's controls. It pushes and closes nothing.
 */
const DialogDoorway = ({ dialogName, label, to }: { dialogName: string; label: string; to: string }) => {
  const navigate = useNavigate()
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const find = () => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((node) => {
        const labelledBy = node.getAttribute('aria-labelledby')
        return labelledBy && document.getElementById(labelledBy)?.textContent === dialogName
      }) ?? null
      setPanel((current) => (current === found || (current?.isConnected && !found) ? current : found))
    }
    find()
    const observer = new MutationObserver(find)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [dialogName])
  if (!panel) return null
  return createPortal(
    <button
      className="admin-btn admin-btn-secondary"
      data-fixture-doorway
      onClick={() => { void navigate(to) }}
      style={{ margin: '0 1.5rem 1rem' }}
      type="button"
    >
      {label}
    </button>,
    panel,
  )
}

const BoardScreen = () => {
  const [search, setSearch] = useSearchParams()
  const open = search.get('task') === TASK
  return (
    <div className="p-6" data-screen="board">
      <h1 className="text-lg font-bold">Engineering board</h1>
      <button
        className="admin-btn admin-btn-primary mt-4"
        onClick={() => setSearch((current) => {
          const next = new URLSearchParams(current)
          next.set('task', TASK)
          return next
        })}
        type="button"
      >
        Open ticket
      </button>
      <TaskDialog
        boardId={BOARD}
        onClose={() => {
          closes.push('task')
          setSearch((current) => {
            const next = new URLSearchParams(current)
            next.delete('task')
            return next
          })
        }}
        open={open}
        projectId={PROJECT}
        task={open ? task : null}
        taskColumnId={COLUMN}
      />
      {open ? <DialogDoorway dialogName="Task details" label="Open board settings" to={SETTINGS} /> : null}
    </div>
  )
}

/**
 * A page that hosts a nested stage, the way Knowledge hosts a folder: on a
 * phone the stack pushes the stage as its own layer; on a split layout the
 * stage renders inline (no host), so only the phone run drives this route.
 */
const StageScreen = () => {
  const [stageOpen, setStageOpen] = useState(false)
  const [pageDialog, setPageDialog] = useState(false)
  const [stageDialog, setStageDialog] = useState(false)
  const [note, setNote] = useState('')
  // The board's ticket reads these before its doorway is used; read them here
  // too, so Board → Settings has its heading when the push lands and the
  // stack's settle focuses it — as it does on the board route.
  useProjects()
  useProjectBoards(PROJECT)
  return (
    <div className="p-6" data-screen="stage-page">
      <h1 className="text-lg font-bold">Docs</h1>
      <button className="admin-btn admin-btn-primary mt-4" onClick={() => setPageDialog(true)} type="button">
        Open page dialog
      </button>
      <Dialog
        onClose={() => { closes.push('page'); setPageDialog(false) }}
        open={pageDialog}
        title="Page dialog"
      >
        <button className="admin-btn admin-btn-secondary" onClick={() => setStageOpen(true)} type="button">
          Open folder stage
        </button>
      </Dialog>
      <NestedStage
        active={stageOpen}
        id="fixture-folder"
        label="Back to docs"
        onBack={() => setStageOpen(false)}
        priority={10}
        title="Folder"
      >
        <div className="p-6" data-screen="stage">
          <h2 className="text-lg font-bold">Folder stage</h2>
          <button className="admin-btn admin-btn-primary mt-4" onClick={() => setStageDialog(true)} type="button">
            Open stage dialog
          </button>
          <Dialog
            onClose={() => { closes.push('stage'); setStageDialog(false) }}
            open={stageDialog}
            title="Stage dialog"
          >
            <label className="grid gap-1 text-sm">
              Note
              <input className="admin-input" onChange={(event) => setNote(event.target.value)} value={note} />
            </label>
          </Dialog>
          {stageDialog ? <DialogDoorway dialogName="Stage dialog" label="Open board settings" to={SETTINGS} /> : null}
        </div>
      </NestedStage>
    </div>
  )
}

const SeedScreen = ({ pathname }: { pathname: string }) => (
  <div className="p-6" data-screen="seed">Seeded {pathname}</div>
)

/** The shell's composition (`AdminShellLayout`), without its chrome. */
const Shell = () => {
  const location = useLocation()
  const outlet = useOutlet()
  const layout = useNavigationLayout()
  const navigation = usePhoneNavigation()
  useEffect(() => {
    Object.assign(window, { overlayLayerFixture: { closes, layout, navigation } })
  }, [layout, navigation])
  return (
    <main
      className="flex min-w-0 flex-1 overflow-clip bg-[color:var(--main)]"
      data-layout={layout}
      style={{ height: '100vh' }}
    >
      <PhoneNavigationViewport
        layout={layout}
        pathname={location.pathname}
        seed={(pathname: string): ReactNode => <SeedScreen pathname={pathname} />}
      >
        {outlet}
      </PhoneNavigationViewport>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthSessionProvider>
      <ApiClientProvider client={client}>
        <AgentIdentityProvider>
          <BrowserRouter>
            <LocalBackProvider>
              <PhoneNavigationProvider>
                <div className="flex" data-ready="true" style={{ background: 'var(--main)', minHeight: '100vh' }}>
                  <Routes>
                    <Route element={<Shell />}>
                      <Route element={<BoardScreen />} path="/projects/:projectId/board" />
                      <Route element={<StageScreen />} path="/projects/:projectId/docs" />
                      <Route element={<BoardSettingsPage />} path="/projects/:projectId/boards/:boardId/settings" />
                    </Route>
                  </Routes>
                </div>
              </PhoneNavigationProvider>
            </LocalBackProvider>
          </BrowserRouter>
        </AgentIdentityProvider>
      </ApiClientProvider>
    </AuthSessionProvider>
  </QueryClientProvider>,
)
