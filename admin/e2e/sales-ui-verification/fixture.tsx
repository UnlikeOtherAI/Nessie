import { useState } from 'react'
import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { AgentCreationModeTabs } from '../../src/components/features/agents/designer/AgentCreationModeTabs'
import { AgentDesignerForm } from '../../src/components/features/agents/designer/AgentDesignerForm'
import { useAgentDesigner } from '../../src/components/features/agents/designer/useAgentDesigner'
import { GoogleScopeRequestCard } from '../../src/components/features/channels/GoogleScopeRequestCard'
import { TodoTemplateEditor } from '../../src/components/features/agents/todos/TodoTemplateEditor'
import { TaskDialog } from '../../src/components/features/projects/kanban/TaskDialog'
import { TaskChecklistTab } from '../../src/components/features/projects/kanban/TaskChecklistTab'
import { GoogleWorkspaceConnectDialog } from '../../src/pages/settings/connections/GoogleWorkspaceConnectDialog'
import type { TaskRecord } from '../../src/facades/tasks/hooks'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
let lastConnectionRequest: unknown = null
let checklist: unknown = null

const salesTask = {
  archivedAt: null, assigneeAgentId: null, assigneeUserId: null,
  createdAt: '2026-09-07T09:00:00.000Z', detail: 'Confirm the venue before inviting prospects.',
  dueDate: null, fieldValues: {}, id: 'task-sales', priority: 'medium', projectId: 'project-sales',
  purpose: 'Book discovery event', status: 'todo', title: 'Verify the business and venue',
  updatedAt: '2026-09-07T09:00:00.000Z',
} as TaskRecord

const client = {
  delete: async () => ({ ok: true }),
  get: async (path: string) => {
    if (path === '/api/projects') return [{ id: 'project-sales', name: 'Sales' }]
    if (path === '/api/tasks/assignees') return []
    if (path === '/api/agents') return [{ id: 'agent-sales', name: 'Sales assistant', todosEnabled: true }]
    if (path === '/api/projects/project-sales/fields') return []
    if (path === '/api/tasks/task-sales/checklist') return checklist
    if (path === '/api/agents/agent-sales/todo-templates') return [{ id: 'template-venue', name: 'Venue research', status: 'active', steps: [] }]
    if (path === '/api/tasks/task-sales/pages') return []
    if (path === '/api/comms/connections') return { connections: [{ id: 'google-sales', provider: 'google', status: 'active' }] }
    throw new Error(`Unexpected GET ${path}`)
  },
  patch: async (path: string, body: Record<string, unknown>) => {
    if (path.includes('/checklist/steps/venue')) {
      checklist = { id: 'checklist-sales', title: 'Venue research', steps: [{ id: 'step-venue', key: 'venue', title: 'Confirm venue', instructions: 'Call the venue.', result: body.result ?? null, completedAt: body.completed ? '2026-09-07T10:00:00.000Z' : null }] }
    }
    return checklist ?? salesTask
  },
  post: async (path: string, body: Record<string, unknown>) => {
    if (path.endsWith('/checklist')) {
      checklist = { id: 'checklist-sales', title: 'Venue research', steps: [{ id: 'step-venue', key: 'venue', title: 'Confirm venue', instructions: 'Call the venue.', result: null, completedAt: null }] }
    } else if (path.endsWith('/google/start')) {
      lastConnectionRequest = body
      ;(window as Window & { salesConnectionRequest?: unknown }).salesConnectionRequest = body
      window.name = JSON.stringify(body)
      return { authorizeUrl: 'about:blank' }
    }
    return checklist ?? salesTask
  },
  put: async () => ({ ok: true }),
} as unknown as ApiClient

const DesignerFixture = () => {
  const [mode, setMode] = useState<'create' | 'configure'>('configure')
  const [section, setSection] = useState<'basics' | 'behavior' | 'todos'>('basics')
  const { actions, state } = useAgentDesigner({ name: 'Venue scout' })
  return <section aria-label="Designer verification" className="grid gap-4">
    <AgentCreationModeTabs onChange={setMode} value={mode} />
    <p data-testid="designer-mode">{mode}</p>
    <AgentDesignerForm actions={actions} canManageExplicitTools={false} canManageTodos modelOptions={[]}
      modelsLoading={false} onSectionChange={setSection} section={section} showTools={false} state={state}
      toolGroups={[]} toolsQuery={{ data: [], isError: false, isLoading: false } as never} />
  </section>
}

const view = new URLSearchParams(window.location.search).get('view')

const Fixture = () => <QueryClientProvider client={queryClient}>
  <AuthSessionProvider><ApiClientProvider client={client}><MemoryRouter><main className="min-h-screen bg-[color:var(--main)] p-8 text-[color:var(--tx)]">
    <div className="mx-auto grid max-w-5xl gap-10"><DesignerFixture />
      {view === 'dialog' ? <TaskDialog onClose={() => undefined} open task={salesTask} /> : null}
      {view === 'calendar' ? <GoogleWorkspaceConnectDialog onClose={() => undefined} open /> : null}
      {view ? null : <><TodoTemplateEditor onCancel={() => undefined} onSave={async () => undefined} saving={false} />
        <section aria-label="Checklist verification"><h2>Checklist</h2><TaskChecklistTab taskId="task-sales" /></section></>}
      <GoogleScopeRequestCard metadata={{ card: { capabilityId: 'meet.create', kind: 'google_scope_request' } }} />
      <output data-testid="connection-request">{JSON.stringify(lastConnectionRequest)}</output></div>
  </main></MemoryRouter></ApiClientProvider></AuthSessionProvider>
</QueryClientProvider>

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Fixture root is missing.')
createRoot(root).render(<Fixture />)
