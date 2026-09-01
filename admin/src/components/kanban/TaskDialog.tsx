import { useEffect, useMemo, useState } from 'react'
import { faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Notice } from '../primitives/Notice'
import { SectionLabel } from '../primitives/SectionLabel'
import { AssigneePicker, type AssigneeValue, type AssigneeOption } from '../shared/AssigneePicker'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { Dialog } from '../shared/Dialog'
import { FieldLabel } from '../primitives/FieldLabel'
import { FormActions } from '../shared/FormActions'
import { FormField } from '../shared/FormField'
import { Input, Select, Textarea } from '../shared/FormControls'
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

export const TaskDialog = ({ open, onClose, task, projectId, iterationId }: TaskDialogProps) => {
  const isEdit = Boolean(task)
  const { data: projects = [] } = useProjects()
  const { data: assignees = [] } = useTaskAssignees()
  const { data: agents = [] } = useAgents()
  const createTask = useCreateTask()
  const updateTask = useUpdateTask()
  const assignTask = useAssignTask()
  const transition = useTransitionTask()

  const [title, setTitle] = useState('')
  const [purpose, setPurpose] = useState('')
  const [detail, setDetail] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [due, setDue] = useState('')
  const [assignee, setAssignee] = useState<AssigneeValue>(null)
  const [formProjectId, setFormProjectId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)

  const assigneeOptions = useMemo<AssigneeOption[]>(
    () => [
      ...assignees.map((user) => ({ id: user.id, name: user.displayName, kind: 'user' as const })),
      ...agents.map((agent) => ({ id: agent.id, name: agent.name, kind: 'agent' as const })),
    ],
    [assignees, agents],
  )

  // Seed the form whenever the dialog opens (or switches to a different task).
  useEffect(() => {
    if (!open) return
    setError(null)
    setTitle(task?.title ?? '')
    setPurpose(task?.purpose ?? '')
    setDetail(task?.detail ?? '')
    setPriority(task?.priority ?? 'medium')
    setDue(toDateInputValue(task?.dueDate ?? null))
    setAssignee(
      task?.assigneeAgentId
        ? { id: task.assigneeAgentId, kind: 'agent' }
        : task?.assigneeUserId
          ? { id: task.assigneeUserId, kind: 'user' }
          : null,
    )
    setFormProjectId('')
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
    <Dialog
      dismissDisabled={pending}
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
          <FormField label="Title" required>
            <Input
              autoComplete="off"
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              value={title}
            />
          </FormField>

          <FormField label="Excerpt">
            <Textarea
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="A short summary…"
              rows={2}
              value={purpose}
            />
          </FormField>

          <FormField label="Detail">
            <Textarea
              onChange={(event) => setDetail(event.target.value)}
              placeholder="The full description, context, acceptance criteria…"
              rows={10}
              value={detail}
            />
          </FormField>
        </div>

        <div className="grid content-start gap-4">
          <div className="grid gap-1.5">
            <SectionLabel as="span" size="sm">Priority</SectionLabel>
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
                    onClick={() => setPriority(value)}
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
            <FieldLabel htmlFor="task-assignee">Assignee</FieldLabel>
            <AssigneePicker
              id="task-assignee"
              onChange={setAssignee}
              options={assigneeOptions}
              value={assignee}
            />
          </div>

          <FormField label="Deadline">
            <Input onChange={(event) => setDue(event.target.value)} type="date" value={due} />
          </FormField>

          {!isEdit && !projectId ? (
            <FormField label="Project">
              <Select onChange={(event) => setFormProjectId(event.target.value)} value={formProjectId}>
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </FormField>
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

        <FormActions
          className="md:col-span-2"
          destructive={
            isEdit && task ? (
              task.archivedAt ? (
                <button
                  className="text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                  onClick={() => void handleUnarchive()}
                  type="button"
                >
                  Unarchive
                </button>
              ) : archived ? (
                <button
                  className="text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
                  onClick={() => void handleStatus('inbox')}
                  type="button"
                >
                  Restore ({statusLabel(task.status)})
                </button>
              ) : (
                <button
                  className="text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                  onClick={() => setCancelConfirmOpen(true)}
                  type="button"
                >
                  Cancel task
                </button>
              )
            ) : null
          }
        >
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
        </FormActions>
      </form>

      <ConfirmDialog
        body="It leaves the board. You can still find it under Archived."
        confirmLabel="Cancel task"
        destructive
        onCancel={() => setCancelConfirmOpen(false)}
        onConfirm={() => {
          setCancelConfirmOpen(false)
          void handleStatus('cancelled')
        }}
        open={cancelConfirmOpen}
        title={task ? `Cancel "${task.title ?? task.purpose ?? 'this task'}"?` : 'Cancel this task?'}
      />
    </Dialog>
  )
}
