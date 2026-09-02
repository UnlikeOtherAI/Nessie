import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Notice } from '../primitives/Notice'
import { AssigneePicker, type AssigneeValue, type AssigneeOption } from '../shared/AssigneePicker'
import { Dialog } from '../shared/Dialog'
import { useAgents } from '../../facades/agents/queries'
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
import { draftKey, useDraft } from '../../navigation/useDraft'
import { ARCHIVED_STATUSES, statusLabel } from './kanban-config'
import { TaskDocuments } from './TaskDocuments'
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  PRIORITY_SIGNAL,
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

// One unsent task, kept whole: partial field state is what a person loses when
// a dialog is dismissed, so it is what the draft has to hold.
type TaskDraft = {
  assignee: AssigneeValue
  detail: string
  due: string
  formProjectId: string
  priority: TaskPriority
  purpose: string
  title: string
}

export const TaskDialog = ({ open, onClose, task, projectId, iterationId }: TaskDialogProps) => {
  const isEdit = Boolean(task)
  const { data: projects = [] } = useProjects()
  const { data: assignees = [] } = useTaskAssignees()
  const { data: agents = [] } = useAgents()
  const createTask = useCreateTask()
  const updateTask = useUpdateTask()
  const assignTask = useAssignTask()
  const transition = useTransitionTask()

  const titleRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  // The task as it stands on the server (blank for a new one) — the draft's
  // baseline, so a dialog opened and closed untouched stores nothing.
  const baseline = useMemo<TaskDraft>(
    () => ({
      assignee: task?.assigneeAgentId
        ? { id: task.assigneeAgentId, kind: 'agent' }
        : task?.assigneeUserId
          ? { id: task.assigneeUserId, kind: 'user' }
          : null,
      detail: task?.detail ?? '',
      due: toDateInputValue(task?.dueDate ?? null),
      formProjectId: '',
      priority: task?.priority ?? 'medium',
      purpose: task?.purpose ?? '',
      title: task?.title ?? '',
    }),
    [task],
  )

  // Drafts (docs/navigation.md → "Drafts"): a task draft is keyed by the task,
  // so dismissing this dialog — by Escape, the scrim or the close cross — keeps
  // the words instead of asking whether to discard them.
  const taskDraft = useDraft<TaskDraft>(
    open ? draftKey('task', task?.id ?? 'new') : null,
    { initial: baseline },
  )
  const { assignee, detail, due, formProjectId, priority, purpose, title } = taskDraft.draft
  const setDraft = taskDraft.setDraft
  const patchDraft = useCallback(
    (patch: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...patch })),
    [setDraft],
  )

  const assigneeOptions = useMemo<AssigneeOption[]>(
    () => [
      ...assignees.map((user) => ({ id: user.id, name: user.displayName, kind: 'user' as const })),
      ...agents.map((agent) => ({ id: agent.id, name: agent.name, kind: 'agent' as const })),
    ],
    [assignees, agents],
  )

  // The draft hook seeds the fields (from its stored row, else the baseline)
  // whenever the key changes; opening only has to clear the last error and put
  // the caret in the title.
  useEffect(() => {
    if (!open) return
    setError(null)
    const id = window.setTimeout(() => titleRef.current?.focus({ preventScroll: true }), 0)
    return () => window.clearTimeout(id)
  }, [open, task])

  const pending =
    createTask.isPending || updateTask.isPending || assignTask.isPending || transition.isPending

  // Still gates the footer's own Close button; the shell's close paths are
  // gated by `dismissDisabled`.
  const handleClose = () => {
    if (pending) return
    onClose()
  }

  if (!open) return null

  const archived = task ? ARCHIVED_STATUSES.includes(task.status) : false
  const canSubmit = title.trim().length > 0 && !pending

  const handleSubmit = async () => {
    setError(null)
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    const trimmedPurpose = purpose.trim()
    const trimmedDetail = detail.trim()
    try {
      const assigneeUserId = assignee?.kind === 'user' ? assignee.id : null
      const assigneeAgentId = assignee?.kind === 'agent' ? assignee.id : null
      if (isEdit && task) {
        await updateTask.mutateAsync({
          id: task.id,
          title: trimmedTitle,
          purpose: trimmedPurpose || null,
          detail: trimmedDetail || null,
          priority,
          dueDate: fromDateInputValue(due),
        })
        const changed =
          (task.assigneeUserId ?? null) !== assigneeUserId ||
          (task.assigneeAgentId ?? null) !== assigneeAgentId
        if (changed) {
          await assignTask.mutateAsync({ id: task.id, assigneeUserId, assigneeAgentId })
        }
      } else {
        await createTask.mutateAsync({
          title: trimmedTitle,
          purpose: trimmedPurpose || undefined,
          detail: trimmedDetail || undefined,
          projectId: projectId ?? (formProjectId || undefined),
          iterationId: iterationId || undefined,
          priority,
          dueDate: fromDateInputValue(due),
          assigneeUserId: assigneeUserId ?? undefined,
          assigneeAgentId: assigneeAgentId ?? undefined,
        })
      }
      taskDraft.clear()
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

  const handleUnarchive = async () => {
    if (!task) return
    setError(null)
    try {
      await updateTask.mutateAsync({ id: task.id, archivedAt: null })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unarchive task')
    }
  }

  return (
    // `dismissDisabled` reproduces the pending gate the old `handleClose` held:
    // scrim, Escape and the close cross all refuse while a mutation is in flight.
    <Dialog
      dismissDisabled={pending}
      initialFocusRef={titleRef}
      onClose={onClose}
      open={open}
      size="xl"
      title={isEdit ? 'Task details' : 'New task'}
    >
      <form
        className="grid gap-5 md:grid-cols-[1.7fr_1fr]"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) void handleSubmit()
        }}
      >
        <div className="grid content-start gap-4">
          <div className="grid gap-1.5">
            <label className={fieldLabel} htmlFor="task-title">
              Title
            </label>
            <input
              ref={titleRef}
              autoComplete="off"
              className="admin-input"
              id="task-title"
              onChange={(event) => patchDraft({ title: event.target.value })}
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
              onChange={(event) => patchDraft({ purpose: event.target.value })}
              placeholder="A short summary…"
              rows={2}
              value={purpose}
            />
          </div>

          <div className="grid gap-1.5">
            <label className={fieldLabel} htmlFor="task-detail">
              Detail
            </label>
            <textarea
              className="admin-input"
              id="task-detail"
              onChange={(event) => patchDraft({ detail: event.target.value })}
              placeholder="The full description, context, acceptance criteria…"
              rows={10}
              value={detail}
            />
          </div>
        </div>

        <div className="grid content-start gap-4">
          <div className="grid gap-1.5">
            <span className={fieldLabel}>Priority</span>
            <div className="flex gap-1.5">
              {PRIORITY_ORDER.map((value) => {
                const active = priority === value
                return (
                  <button
                    key={value}
                    className={[
                      'flex flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 py-1.5 text-[11px] font-semibold transition-colors',
                      active
                        ? 'bg-[color:var(--overlay)] text-[color:var(--tx)] ring-1 ring-inset ring-[color:var(--sep)]'
                        : 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
                    ].join(' ')}
                    onClick={() => patchDraft({ priority: value })}
                    type="button"
                  >
                    <FontAwesomeIcon
                      className={`text-[11px] ${PRIORITY_SIGNAL[value]} ${active ? '' : 'opacity-50'}`}
                      icon={faSignal}
                    />
                    {PRIORITY_LABEL[value]}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid gap-1.5">
            <label className={fieldLabel} htmlFor="task-assignee">
              Assignee
            </label>
            <AssigneePicker
              id="task-assignee"
              onChange={(next) => patchDraft({ assignee: next })}
              options={assigneeOptions}
              value={assignee}
            />
          </div>

          <div className="grid gap-1.5">
            <label className={fieldLabel} htmlFor="task-due">
              Deadline
            </label>
            <input
              className="admin-input"
              id="task-due"
              onChange={(event) => patchDraft({ due: event.target.value })}
              type="date"
              value={due}
            />
          </div>

          {!isEdit && !projectId ? (
            <div className="grid gap-1.5">
              <label className={fieldLabel} htmlFor="task-project">
                Project
              </label>
              <select
                className="admin-input"
                id="task-project"
                onChange={(event) => patchDraft({ formProjectId: event.target.value })}
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
        </div>

        {isEdit && task ? <TaskDocuments taskId={task.id} /> : null}

        {/*
          One banner for three mutations (save, status transition, unarchive),
          so it belongs to the form rather than to a field — no `aria-invalid`
          target exists. `role="alert"` is the whole delta: each of the three
          catch blocks clears the message before its await and writes it only
          on failure, so it announces once per rejected action.
        */}
        {error ? (
          <Notice className="md:col-span-2" role="alert" size="sm" tone="danger">
            {error}
          </Notice>
        ) : null}

        <div className="flex items-center justify-between pt-1 md:col-span-2">
          <div className="text-xs">
            {isEdit && task ? (
              task.archivedAt ? (
                <button
                  className="font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                  onClick={() => void handleUnarchive()}
                  type="button"
                >
                  Unarchive
                </button>
              ) : archived ? (
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
    </Dialog>
  )
}
