import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

type TaskStatus =
  | 'inbox'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval'

type TaskRecord = {
  id: string
  status: TaskStatus
  title: string | null
  purpose: string | null
  assigneeUserId: string | null
  assigneeName: string | null
  ownerName: string | null
  createdAt: string
  updatedAt: string
}

type AssignableUser = {
  id: string
  displayName: string
}

type Tab = 'mine' | 'all'

const STATUS_TONE: Record<TaskStatus, string> = {
  inbox: 'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
  assigned: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  in_progress: 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  review: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  awaiting_approval: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  done: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  failed: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  cancelled: 'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
}

// Primary lifecycle actions surfaced as buttons, per current status.
const NEXT_ACTIONS: Partial<Record<TaskStatus, Array<{ label: string; status: TaskStatus }>>> = {
  inbox: [{ label: 'Start', status: 'in_progress' }],
  assigned: [{ label: 'Start', status: 'in_progress' }],
  in_progress: [
    { label: 'Send to review', status: 'review' },
    { label: 'Done', status: 'done' },
  ],
  review: [
    { label: 'Done', status: 'done' },
    { label: 'Reopen', status: 'in_progress' },
  ],
  awaiting_approval: [{ label: 'Done', status: 'done' }],
  done: [{ label: 'Reopen', status: 'in_progress' }],
  failed: [{ label: 'Reopen', status: 'in_progress' }],
  cancelled: [{ label: 'Reopen', status: 'inbox' }],
}

const labelFor = (status: TaskStatus): string => status.replace(/_/g, ' ')

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const WorkPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const [tab, setTab] = useState<Tab>('mine')
  const [title, setTitle] = useState('')
  const [purpose, setPurpose] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')

  const tasksQuery = useQuery<TaskRecord[]>({
    queryKey: ['tasks', tab],
    queryFn: () => apiClient.get(`/api/tasks${tab === 'mine' ? '?assignee=me' : ''}`),
    enabled: Boolean(me),
  })

  const assigneesQuery = useQuery<AssignableUser[]>({
    queryKey: ['task-assignees'],
    queryFn: () => apiClient.get('/api/tasks/assignees'),
    enabled: Boolean(me),
  })

  const assignees = useMemo(() => assigneesQuery.data ?? [], [assigneesQuery.data])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  }

  const createTask = useMutation({
    mutationFn: () =>
      apiClient.post('/api/tasks', {
        title: title.trim(),
        purpose: purpose.trim() || undefined,
        assigneeUserId: assigneeUserId || undefined,
      }),
    onSuccess: () => {
      setTitle('')
      setPurpose('')
      setAssigneeUserId('')
      invalidate()
    },
  })

  const reassign = useMutation({
    mutationFn: (input: { id: string; assigneeUserId: string | null }) =>
      apiClient.post(`/api/tasks/${input.id}/assign`, {
        assigneeUserId: input.assigneeUserId,
      }),
    onSuccess: invalidate,
  })

  const transition = useMutation({
    mutationFn: (input: { id: string; status: TaskStatus }) =>
      apiClient.post(`/api/tasks/${input.id}/transition`, { status: input.status }),
    onSuccess: invalidate,
  })

  const tasks = tasksQuery.data ?? []
  const canSubmit = title.trim().length > 0 && !createTask.isPending

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-3 border-b border-[color:var(--sep)] px-5">
        <div className={sectionTitle}>Work</div>
        <div className="ml-2 flex gap-1">
          <button
            className={[
              'rounded-md px-2.5 py-1 text-xs font-semibold',
              tab === 'mine'
                ? 'bg-[color:var(--overlay)] text-[color:var(--tx)]'
                : 'text-[color:var(--tx3)]',
            ].join(' ')}
            onClick={() => setTab('mine')}
            type="button"
          >
            My Queue
          </button>
          <button
            className={[
              'rounded-md px-2.5 py-1 text-xs font-semibold',
              tab === 'all'
                ? 'bg-[color:var(--overlay)] text-[color:var(--tx)]'
                : 'text-[color:var(--tx3)]',
            ].join(' ')}
            onClick={() => setTab('all')}
            type="button"
          >
            All work
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <form
          className="admin-card mb-4 grid gap-2 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) createTask.mutate()
          }}
        >
          <div className={sectionTitle}>New task</div>
          <input
            className="admin-input"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Task title"
            value={title}
          />
          <textarea
            className="admin-input"
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="Description (optional)"
            rows={2}
            value={purpose}
          />
          <div className="flex items-center gap-2">
            <select
              className="admin-input max-w-xs"
              onChange={(event) => setAssigneeUserId(event.target.value)}
              value={assigneeUserId}
            >
              <option value="">Unassigned</option>
              {assignees.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
            <button
              className="admin-button admin-button-primary"
              disabled={!canSubmit}
              type="submit"
            >
              Create task
            </button>
          </div>
          {createTask.isError && (
            <div className="text-xs text-[color:var(--danger-text)]">
              {(createTask.error as Error).message}
            </div>
          )}
        </form>

        <div className={sectionTitle}>
          {tab === 'mine' ? 'Assigned to me' : 'All work'} ({tasks.length})
        </div>
        <div className="mt-2 grid gap-2">
          {tasks.map((task) => (
            <div key={task.id} className="admin-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-[color:var(--tx)]">
                    {task.title ?? task.purpose ?? 'Untitled task'}
                  </div>
                  {task.purpose && task.title && (
                    <div className="mt-1 text-sm text-[color:var(--tx2)]">{task.purpose}</div>
                  )}
                </div>
                <span
                  className={[
                    'shrink-0 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]',
                    STATUS_TONE[task.status],
                  ].join(' ')}
                >
                  {labelFor(task.status)}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-[color:var(--tx3)]">Assignee</span>
                <select
                  className="admin-input max-w-[200px] py-1.5 text-sm"
                  disabled={reassign.isPending}
                  onChange={(event) =>
                    reassign.mutate({
                      id: task.id,
                      assigneeUserId: event.target.value || null,
                    })
                  }
                  value={task.assigneeUserId ?? ''}
                >
                  <option value="">Unassigned</option>
                  {assignees.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.displayName}
                    </option>
                  ))}
                </select>

                <div className="ml-auto flex gap-2">
                  {(NEXT_ACTIONS[task.status] ?? []).map((action) => (
                    <button
                      key={action.status}
                      className="admin-button admin-button-secondary"
                      disabled={transition.isPending}
                      onClick={() => transition.mutate({ id: task.id, status: action.status })}
                      type="button"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {tasksQuery.isError && (
            <div className="py-10 text-center text-sm text-[color:var(--danger-text)]">
              Failed to load tasks. Please refresh.
            </div>
          )}
          {tasksQuery.isLoading && (
            <div className="py-10 text-center text-[color:var(--tx3)]">Loading…</div>
          )}
          {!tasksQuery.isError && !tasksQuery.isLoading && tasks.length === 0 && (
            <div className="py-10 text-center text-[color:var(--tx3)]">
              {tab === 'mine' ? 'Nothing assigned to you yet' : 'No work items yet'}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
