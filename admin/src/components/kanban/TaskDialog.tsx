import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../../facades/projects/hooks'
import {
  type TaskPriority,
  type TaskRecord,
  useAssignTask,
  useCreateTask,
  useTaskAssignees,
  useTransitionTask,
  useUpdateTask,
} from '../../facades/tasks/hooks'
import { ARCHIVED_STATUSES, statusLabel } from './kanban-config'
import {
  PRIORITY_CHIP,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  fromDateInputValue,
  toDateInputValue,
} from './task-meta'

type TaskDialogProps = {
  open: boolean
  onClose: () => void
  // When set, the dialog edits this task; otherwise it creates a new one.
  task?: TaskRecord | null
  // Create-mode context: pin the new task to a project / iteration.
  projectId?: string
  iterationId?: string
}

const fieldLabel = 'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'

export const TaskDialog = ({ open, onClose, task, projectId, iterationId }: TaskDialogProps) => {
  const isEdit = Boolean(task)
  const { data: projects = [] } = useProjects()
  const { data: assignees = [] } = useTaskAssignees()
  const createTask = useCreateTask()
  const updateTask = useUpdateTask()
  const assignTask = useAssignTask()
  const transition = useTransitionTask()

  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [purpose, setPurpose] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [due, setDue] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [formProjectId, setFormProjectId] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Seed the form whenever the dialog opens (or switches to a different task).
  useEffect(() => {
    if (!open) return
    setError(null)
    setTitle(task?.title ?? '')
    setPurpose(task?.purpose ?? '')
    setPriority(task?.priority ?? 'medium')
    setDue(toDateInputValue(task?.dueDate ?? null))
    setAssigneeUserId(task?.assigneeUserId ?? '')
    setFormProjectId('')
    const id = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [open, task])

  if (!open) return null

  const archived = task ? ARCHIVED_STATUSES.includes(task.status) : false
  const pending =
    createTask.isPending || updateTask.isPending || assignTask.isPending || transition.isPending
  const canSubmit = title.trim().length > 0 && !pending

  const handleClose = () => {
    if (pending) return
    onClose()
  }

  const handleSubmit = async () => {
    setError(null)
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    const trimmedPurpose = purpose.trim()
    try {
      if (isEdit && task) {
        await updateTask.mutateAsync({
          id: task.id,
          title: trimmedTitle,
          purpose: trimmedPurpose || null,
          priority,
          dueDate: fromDateInputValue(due),
        })
        if ((task.assigneeUserId ?? '') !== assigneeUserId) {
          await assignTask.mutateAsync({ id: task.id, assigneeUserId: assigneeUserId || null })
        }
      } else {
        await createTask.mutateAsync({
          title: trimmedTitle,
          purpose: trimmedPurpose || undefined,
          projectId: projectId ?? (formProjectId || undefined),
          iterationId: iterationId || undefined,
          priority,
          dueDate: fromDateInputValue(due),
          assigneeUserId: assigneeUserId || undefined,
        })
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong')
    }
  }

  const handleStatus = async (status: TaskRecord['status']) => {
    if (!task) return
    setError(null)
    try {
      await transition.mutateAsync({ id: task.id, status })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update status')
    }
  }

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') handleClose()
      }}
      role="presentation"
      style={{
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        background: 'var(--scrim-strong)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 9999,
      }}
    >
      <div className="create-channel-panel">
        <div className="create-channel-header">
          <h2 className="text-lg font-bold text-[color:var(--tx)]">
            {isEdit ? 'Task details' : 'New task'}
          </h2>
          <button
            className={[
              'flex h-7 w-7 items-center justify-center',
              'rounded text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={handleClose}
            type="button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) void handleSubmit()
          }}
        >
          <div className="grid gap-1.5">
            <label className={fieldLabel} htmlFor="task-title">
              Title
            </label>
            <input
              ref={titleRef}
              autoComplete="off"
              className="admin-input"
              id="task-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              value={title}
            />
          </div>

          <div className="grid gap-1.5">
            <label className={fieldLabel} htmlFor="task-purpose">
              Excerpt
            </label>
            <textarea
              className="admin-input"
              id="task-purpose"
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="A short summary…"
              rows={3}
              value={purpose}
            />
          </div>

          <div className="grid gap-1.5">
            <span className={fieldLabel}>Priority</span>
            <div className="flex gap-1.5">
              {PRIORITY_ORDER.map((value) => {
                const active = priority === value
                return (
                  <button
                    key={value}
                    className={[
                      'flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors',
                      active
                        ? PRIORITY_CHIP[value]
                        : 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
                    ].join(' ')}
                    onClick={() => setPriority(value)}
                    type="button"
                  >
                    {PRIORITY_LABEL[value]}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className={fieldLabel} htmlFor="task-assignee">
                Assignee
              </label>
              <select
                className="admin-input"
                id="task-assignee"
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
            </div>
            <div className="grid gap-1.5">
              <label className={fieldLabel} htmlFor="task-due">
                Deadline
              </label>
              <input
                className="admin-input"
                id="task-due"
                onChange={(event) => setDue(event.target.value)}
                type="date"
                value={due}
              />
            </div>
          </div>

          {!isEdit && !projectId ? (
            <div className="grid gap-1.5">
              <label className={fieldLabel} htmlFor="task-project">
                Project
              </label>
              <select
                className="admin-input"
                id="task-project"
                onChange={(event) => setFormProjectId(event.target.value)}
                value={formProjectId}
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-[color:var(--danger-border)] bg-[color:var(--danger-soft)] px-3 py-2 text-xs text-[color:var(--danger-text)]">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-1">
            <div className="text-xs">
              {isEdit && task ? (
                archived ? (
                  <button
                    className="font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                    onClick={() => void handleStatus('inbox')}
                    type="button"
                  >
                    Restore ({statusLabel(task.status)})
                  </button>
                ) : (
                  <button
                    className="font-semibold text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                    onClick={() => void handleStatus('cancelled')}
                    type="button"
                  >
                    Cancel task
                  </button>
                )
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                className="admin-button admin-button-secondary"
                onClick={handleClose}
                type="button"
              >
                Close
              </button>
              <button className="admin-button admin-button-primary" disabled={!canSubmit} type="submit">
                {isEdit ? 'Save changes' : 'Create task'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
