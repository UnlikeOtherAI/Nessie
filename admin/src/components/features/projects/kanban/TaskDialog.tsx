import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { AgentVisibility } from '@nessie/schemas'
import { Notice } from '../../../primitives/Notice'
import { AssigneePicker, type AssigneeValue, type AssigneeOption } from '../../../shared/AssigneePicker'
import { RemotePersonPill } from './RemotePersonPill'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { Dialog } from '../../../shared/Dialog'
import { FieldLabel } from '../../../primitives/FieldLabel'
import { FormField } from '../../../shared/FormField'
import { PROVIDER_LABEL } from '../../../../facades/board-sources/hooks'
import { TaskFieldsSection } from './TaskFieldsSection'
import { useTaskFields } from '../../../../facades/task-fields/hooks'
import { Input, Select, Textarea } from '../../../shared/FormControls'
import { useAgents } from '../../../../facades/agents/queries'
import { useTabParam } from '../../../../navigation/useTabParam'
import { useProjects } from '../../../../facades/projects/hooks'
import {
  type TaskPriority,
  type TaskRecord,
  useAssignTask,
  useCreateTask,
  useMoveTask,
  useTaskAssignees,
  useTransitionTask,
  useUpdateTask,
} from '../../../../facades/tasks/hooks'
import { draftKey, useDraft } from '../../../../navigation/useDraft'
import { isArchivedStatus } from './kanban-config'
import { TaskDialogActions } from './TaskDialogActions'
import { TaskDocuments } from './TaskDocuments'
import { TaskPlacementField } from './TaskPlacementField'
import { TaskPriorityField } from './TaskPriorityField'
import { TaskChecklistTab } from './TaskChecklistTab'
import { fromDateInputValue, toDateInputValue } from './task-meta'
import { TabBar } from '../../../primitives/TabBar'

// One unsent task, kept whole: partial field state is what a person loses when
// a dialog is dismissed, so it is what the draft has to hold.
type TaskDraft = {
  assignee: AssigneeValue
  columnId: string | null
  detail: string
  due: string
  fieldValues: Record<string, unknown>
  formProjectId: string
  priority: TaskPriority
  purpose: string
  title: string
}

type TaskDialogTab = 'details' | 'checklist'
const TASK_DIALOG_TABS: readonly TaskDialogTab[] = ['details', 'checklist']

type TaskDialogProps = {
  open: boolean
  onClose: () => void
  // When set, the dialog edits this task; otherwise it creates a new one.
  task?: TaskRecord | null
  // Create-mode context: pin the new task to a project / board / iteration.
  projectId?: string
  // The board the card is created on. A board owns its tasks, so a card made
  // while looking at "Dev" belongs to Dev and appears on no other board.
  boardId?: string
  /** The card's current column when details opened from a board. */
  taskColumnId?: string | null
  iterationId?: string
}

/**
 * Only the fields that actually changed, with a cleared one sent as `null` so
 * the server's merge removes it. Sending the whole bag would overwrite a value
 * somebody else set while this dialog was open.
 */
const fieldValuesPatch = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = after[key]
    if (JSON.stringify(next ?? null) === JSON.stringify(before[key] ?? null)) continue
    patch[key] = next ?? null
  }
  return patch
}

const changedFieldValues = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean => Object.keys(fieldValuesPatch(before, after)).length > 0

export const TaskDialog = ({
  open,
  onClose,
  task,
  projectId,
  boardId,
  taskColumnId,
  iterationId,
}: TaskDialogProps) => {
  const isEdit = Boolean(task)
  const location = useLocation()
  const { data: projects = [] } = useProjects()
  const { data: assignees = [] } = useTaskAssignees()
  const { data: agents = [] } = useAgents()
  const createTask = useCreateTask()
  const moveTask = useMoveTask()
  const updateTask = useUpdateTask()
  const assignTask = useAssignTask()
  const transition = useTransitionTask()

  // Custom fields belong to the project, which for an existing task is the
  // task's own and for a new one the project the dialog was opened in.
  const fieldsProjectId = task?.projectId ?? projectId ?? null
  const { data: fieldDefinitions = [] } = useTaskFields(fieldsProjectId ?? undefined)

  const titleRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const [dialogTab, setDialogTab] = useTabParam(
    'taskTab',
    TASK_DIALOG_TABS,
    'details',
  )
  const resetDialogTabRef = useRef(setDialogTab)
  resetDialogTabRef.current = setDialogTab
  const hasExplicitTaskTab = TASK_DIALOG_TABS.some(
    (tab) => tab === new URLSearchParams(location.search).get('taskTab'),
  )

  // The task as it stands on the server (blank for a new one) — the draft's
  // baseline, so a dialog opened and closed untouched stores nothing.
  const baseline = useMemo<TaskDraft>(
    () => ({
      assignee: task?.assigneeAgentId
        ? { id: task.assigneeAgentId, kind: 'agent' }
        : task?.assigneeUserId
          ? { id: task.assigneeUserId, kind: 'user' }
          : null,
      columnId: taskColumnId ?? null,
      detail: task?.detail ?? '',
      due: toDateInputValue(task?.dueDate ?? null),
      fieldValues: task?.fieldValues ?? {},
      formProjectId: '',
      priority: task?.priority ?? 'medium',
      purpose: task?.purpose ?? '',
      title: task?.title ?? '',
    }),
    [task, taskColumnId],
  )

  // Drafts (docs/navigation/overview.md → "Drafts"): a task draft is keyed by the task,
  // so dismissing this dialog — by Escape, the scrim or the close cross — keeps
  // the words instead of asking whether to discard them.
  const taskDraft = useDraft<TaskDraft>(
    open ? draftKey('task', task?.id ?? 'new') : null,
    { initial: baseline },
  )
  const {
    assignee,
    columnId = taskColumnId ?? null,
    detail,
    due,
    fieldValues,
    formProjectId,
    priority,
    purpose,
    title,
  } = taskDraft.draft
  const setDraft = taskDraft.setDraft
  const patchDraft = useCallback(
    (patch: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...patch })),
    [setDraft],
  )

  // Who the provider says is on it, when that is nobody Nessie knows. Hidden as
  // soon as the draft names somebody, because choosing a colleague is the
  // answer to it.
  const remoteAssignee =
    !assignee && task?.externalLink?.remoteAssigneeDisplay
      ? {
          displayName: task.externalLink.remoteAssigneeDisplay,
          provider: task.externalLink.provider,
        }
      : null

  const assigneeOptions = useMemo<AssigneeOption[]>(
    () => [
      ...assignees.map((user) => ({ id: user.id, name: user.displayName, kind: 'user' as const })),
      ...agents.map((agent) => ({
        agentVisibility: agent.visibility as AgentVisibility,
        id: agent.id,
        name: agent.name,
        kind: 'agent' as const,
      })),
    ],
    [assignees, agents],
  )

  // The draft hook seeds the fields (from its stored row, else the baseline)
  // whenever the key changes; opening only has to clear the last error.
  useEffect(() => {
    if (!open) return
    setError(null)
    // `taskTab=checklist` belongs to an existing task. A creation dialog has
    // no checklist yet, so a retained edit URL must not select its empty pane.
    if (!isEdit || !hasExplicitTaskTab) resetDialogTabRef.current('details')
  }, [hasExplicitTaskTab, isEdit, open, task?.id])

  const pending =
    createTask.isPending
    || updateTask.isPending
    || assignTask.isPending
    || moveTask.isPending
    || transition.isPending

  // Still gates the footer's own Close button; the shell's close paths are
  // gated by `dismissDisabled`.
  const handleClose = () => {
    if (pending) return
    onClose()
  }

  if (!open) return null

  const archived = task ? isArchivedStatus(task.status) : false
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
          ...(changedFieldValues(task.fieldValues ?? {}, fieldValues)
            ? { fieldValues: fieldValuesPatch(task.fieldValues ?? {}, fieldValues) }
            : {}),
        })
        const changed =
          (task.assigneeUserId ?? null) !== assigneeUserId ||
          (task.assigneeAgentId ?? null) !== assigneeAgentId
        if (changed) {
          await assignTask.mutateAsync({ id: task.id, assigneeUserId, assigneeAgentId })
        }
        if (columnId && columnId !== taskColumnId) {
          // A column is part of this edit draft, so an external/source-owned
          // rejection leaves every unsaved field in place for correction.
          await moveTask.mutateAsync({ id: task.id, columnId })
        }
      } else {
        await createTask.mutateAsync({
          title: trimmedTitle,
          purpose: trimmedPurpose || undefined,
          detail: trimmedDetail || undefined,
          projectId: projectId ?? (formProjectId || undefined),
          // Only meaningful together with the project it belongs to: the
          // project picker in the dialog names no board.
          ...(projectId && boardId ? { boardId } : {}),
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
      {task?.externalLink ? (
        <Notice className="mb-4" size="sm" tone="info">
          Linked to {PROVIDER_LABEL[task.externalLink.provider]}{' '}
          <a
            className="underline"
            href={task.externalLink.externalUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {task.externalLink.externalKey}
          </a>
          {task.externalLink.remoteStateName
            ? ` · ${task.externalLink.remoteStateName}`
            : ''}
          {task.externalLink.writeMode === 'read_only'
            ? ` · ${PROVIDER_LABEL[task.externalLink.provider]} owns its status, assignee and
               title here. Switch the source to read & write in Settings → Sources to change
               them from Nessie.`
            : ''}
        </Notice>
      ) : null}

      {isEdit && task ? (
        <div className="mb-5">
          <TabBar<TaskDialogTab>
            ariaLabel="Task details sections"
            items={[{ label: 'Details', value: 'details' }, { label: 'Checklist', value: 'checklist' }]}
            onChange={setDialogTab}
            value={dialogTab}
          />
        </div>
      ) : null}

      {isEdit && task && dialogTab === 'checklist' ? <TaskChecklistTab taskId={task.id} /> : null}

      <form
        className={dialogTab === 'checklist' ? 'hidden' : 'grid gap-5 md:grid-cols-[1.7fr_1fr]'}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmit) void handleSubmit()
        }}
      >
        <div className="grid content-start gap-4">
          <FormField label="Title" required>
            <Input
              autoComplete="off"
              onChange={(event) => patchDraft({ title: event.target.value })}
              placeholder="What needs doing?"
              ref={titleRef}
              value={title}
            />
          </FormField>

          <FormField label="Excerpt">
            <Textarea
              onChange={(event) => patchDraft({ purpose: event.target.value })}
              placeholder="A short summary…"
              rows={2}
              value={purpose}
            />
          </FormField>

          <FormField label="Detail">
            <Textarea
              onChange={(event) => patchDraft({ detail: event.target.value })}
              placeholder="The full description, context, acceptance criteria…"
              rows={10}
              value={detail}
            />
          </FormField>
        </div>

          <div className="grid content-start gap-4">
          <TaskPriorityField onChange={(value) => patchDraft({ priority: value })} value={priority} />

          <div className="grid gap-1.5">
            <FieldLabel htmlFor="task-assignee">Assignee</FieldLabel>
            <AssigneePicker
              id="task-assignee"
              onChange={(next) => patchDraft({ assignee: next })}
              options={assigneeOptions}
              value={assignee}
            />
            {remoteAssignee ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--tx3)]">
                <RemotePersonPill
                  displayName={remoteAssignee.displayName}
                  provider={remoteAssignee.provider}
                />
                <span>
                  has it in {PROVIDER_LABEL[remoteAssignee.provider]} and has no Nessie account.
                </span>
              </div>
            ) : null}
          </div>

          <FormField label="Deadline">
            <Input onChange={(event) => patchDraft({ due: event.target.value })} type="date" value={due} />
          </FormField>

          {isEdit && task && !archived ? (
            <TaskPlacementField
              boardId={boardId}
              columnId={columnId}
              disabled={pending}
              onChange={(nextColumnId) => patchDraft({ columnId: nextColumnId })}
              projectId={fieldsProjectId}
              task={task}
              taskColumnId={taskColumnId}
            />
          ) : null}

          <TaskFieldsSection
            definitions={fieldDefinitions}
            manageHref={
              fieldsProjectId
                ? `/projects/${fieldsProjectId}/settings?section=fields`
                : undefined
            }
            onChange={(fieldId, value) =>
              patchDraft({ fieldValues: { ...fieldValues, [fieldId]: value } })
            }
            people={assignees}
            values={fieldValues}
          />

          {!isEdit && !projectId ? (
            <FormField label="Project">
              <Select onChange={(event) => patchDraft({ formProjectId: event.target.value })} value={formProjectId}>
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

        {isEdit && task ? <TaskDocuments projectId={task.projectId} taskId={task.id} /> : null}

        {/*
          One banner for four mutations (save, column move, status transition,
          unarchive),
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

        <TaskDialogActions
          archived={archived}
          canSubmit={canSubmit}
          onCancel={() => setCancelConfirmOpen(true)}
          onClose={handleClose}
          onRestore={() => void handleStatus('inbox')}
          onUnarchive={() => void handleUnarchive()}
          task={isEdit ? task : null}
        />
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
