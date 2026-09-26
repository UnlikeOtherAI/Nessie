import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isArchivedStatus, statusLabel } from '../../components/features/projects/kanban/kanban-config'
import { NewTaskButton } from '../../components/features/projects/kanban/NewTaskButton'
import { taskStatusTone } from '../../components/features/projects/kanban/task-status-presentation'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { Input } from '../../components/shared/FormControls'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { Pill } from '../../components/primitives/Pill'
import {
  type Iteration,
  useCreateIteration,
  useDeleteIteration,
  useIterations,
  useUpdateIteration,
} from '../../facades/iterations/hooks'
import {
  type TaskRecord,
  useSetTaskIteration,
  useTasks,
  useUpdateTaskPoints,
} from '../../facades/tasks/hooks'
import { useCanModifyProject } from '../../facades/projects/administration'

const PointsInput = ({ task }: { task: TaskRecord }) => {
  const { t } = useTranslation('projects')
  const update = useUpdateTaskPoints()
  const [value, setValue] = useState(task.storyPoints?.toString() ?? '')
  const commit = () => {
    const trimmed = value.trim()
    const points = trimmed === '' ? null : Math.max(0, Math.floor(Number(trimmed)))
    if ((task.storyPoints ?? null) !== points && !Number.isNaN(points ?? 0)) {
      update.mutate({ id: task.id, storyPoints: points })
    }
  }
  return (
    <input
      aria-label={t('backlog.storyPoints')}
      className="admin-input admin-input-compact max-w-12 text-center"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      placeholder="–"
      value={value}
    />
  )
}

const TaskRow = ({
  task,
  moveTargets,
}: {
  task: TaskRecord
  moveTargets: { id: string; name: string }[]
}) => {
  const { t } = useTranslation('projects')
  const setIteration = useSetTaskIteration()
  return (
    <div className="flex items-center gap-2 rounded-md bg-[color:var(--sb)] px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
        {task.title ?? task.purpose ?? t('task.untitled')}
      </span>
      <Pill size="sm" tone={taskStatusTone(task.status)}>
        {statusLabel(task.status, t)}
      </Pill>
      <PointsInput task={task} />
      <select
        aria-label={t('backlog.moveToSprint')}
        className="admin-input admin-input-compact max-w-[150px]"
        onChange={(event) =>
          setIteration.mutate({ id: task.id, iterationId: event.target.value || null })
        }
        value={task.iterationId ?? ''}
      >
        <option value="">{t('backlog.backlog')}</option>
        {moveTargets.map((target) => (
          <option key={target.id} value={target.id}>
            {target.name}
          </option>
        ))}
      </select>
    </div>
  )
}

const IterationCard = ({
  iteration,
  projectId,
  canAdminister,
  tasks,
  moveTargets,
}: {
  iteration: Iteration
  projectId: string
  canAdminister: boolean
  tasks: TaskRecord[]
  moveTargets: { id: string; name: string }[]
}) => {
  const { t } = useTranslation('projects')
  const update = useUpdateIteration(projectId)
  const remove = useDeleteIteration(projectId)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const iterationStatus = iteration.status === 'active'
    ? t('backlog.status.active')
    : iteration.status === 'completed'
      ? t('backlog.status.completed')
      : t('backlog.status.planned')

  return (
    <>
      <div className="admin-card grid gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[color:var(--tx)]">{iteration.name}</span>
          <Pill size="sm">{iterationStatus}</Pill>
          <span className="text-xs text-[color:var(--tx3)]">
            {t('backlog.iterationSummary', { done: iteration.pointsDone, total: iteration.pointsTotal, tasks: iteration.taskCount })}
          </span>
          {canAdminister ? (
            <div className="ml-auto flex gap-2">
              {iteration.status === 'planned' ? (
                <button
                  className="admin-button admin-button-primary admin-button-compact"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: iteration.id, action: 'start' })}
                  type="button"
                >
                  {t('backlog.start')}
                </button>
              ) : null}
              {iteration.status === 'active' ? (
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: iteration.id, action: 'complete' })}
                  type="button"
                >
                  {t('backlog.complete')}
                </button>
              ) : null}
              <button
                className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                onClick={() => setDeleteOpen(true)}
                type="button"
              >
                {t('backlog.delete')}
              </button>
            </div>
          ) : null}
        </div>
        {iteration.goal ? (
          <div className="text-xs text-[color:var(--tx2)]">{iteration.goal}</div>
        ) : null}
        <div className="grid gap-1">
          {tasks.length === 0 ? (
            <div className="text-xs text-[color:var(--tx3)]">{t('backlog.noTasksInSprint')}</div>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} moveTargets={moveTargets} task={task} />)
          )}
        </div>
      </div>

      <ConfirmDialog
        body={t('backlog.deleteSprintBody')}
        confirmLabel={t('backlog.delete')}
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove.mutate(iteration.id)
        }}
        open={canAdminister && deleteOpen}
        title={t('backlog.deleteSprintTitle', { name: iteration.name })}
      />
    </>
  )
}

type ProjectBacklogTabProps = {
  projectId: string
}

export const ProjectBacklogTab = ({ projectId }: ProjectBacklogTabProps) => {
  const { t } = useTranslation('projects')
  const canAdminister = useCanModifyProject(projectId)
  const iterationsQuery = useIterations(projectId)
  const tasksQuery = useTasks(projectId)
  // Memoised so the empty-array fallback is not a fresh literal every render;
  // the planning/completed memos below key off this identity.
  const iterations = useMemo(() => iterationsQuery.data ?? [], [iterationsQuery.data])
  const tasks = tasksQuery.data ?? []
  const createIteration = useCreateIteration(projectId)
  const [newName, setNewName] = useState('')

  // Both queries feed every section on this tab, so a failure or an in-flight
  // fetch on either one is a fetch state for the whole tab, not just one list.
  const backlogQuery = {
    isError: iterationsQuery.isError || tasksQuery.isError,
    isLoading: iterationsQuery.isLoading || tasksQuery.isLoading,
    refetch: () => {
      void iterationsQuery.refetch()
      void tasksQuery.refetch()
    },
  }

  const planning = useMemo(
    () => iterations.filter((i) => i.status !== 'completed'),
    [iterations],
  )
  const completed = useMemo(
    () => iterations.filter((i) => i.status === 'completed'),
    [iterations],
  )
  const moveTargets = planning.map((i) => ({ id: i.id, name: i.name }))

  const visibleTasks = tasks.filter((task) => !isArchivedStatus(task.status))
  const backlogTasks = visibleTasks.filter((task) => !task.iterationId)
  const tasksByIteration = (iterationId: string) =>
    visibleTasks.filter((task) => task.iterationId === iterationId)

  const handleCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    createIteration.mutate({ name: trimmed }, { onSuccess: () => setNewName('') })
  }

  return (
    <PageBody>
      <QueryState
        errorLabel={t('backlog.error')}
        loadingLabel={t('backlog.loading')}
        query={backlogQuery}
      >
        {() => (
          <>
            <Section title={t('backlog.sprints')}>
              {planning.length === 0 ? (
                <div className="text-xs text-[color:var(--tx3)]">{t('backlog.noSprints')}</div>
              ) : (
                <div className="grid gap-2">
                  {planning.map((iteration) => (
                    <IterationCard
                      key={iteration.id}
                      canAdminister={canAdminister}
                      iteration={iteration}
                      moveTargets={moveTargets}
                      projectId={projectId}
                      tasks={tasksByIteration(iteration.id)}
                    />
                  ))}
                </div>
              )}
              {canAdminister ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    handleCreate()
                  }}
                >
                  <Input
                    aria-label={t('backlog.sprintName')}
                    className="min-w-0 flex-1"
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder={t('backlog.newSprintPlaceholder')}
                    size="compact"
                    value={newName}
                  />
                  <button
                    className="admin-button admin-button-primary admin-button-compact"
                    disabled={!newName.trim() || createIteration.isPending}
                    type="submit"
                  >
                    {t('backlog.addSprint')}
                  </button>
                </form>
              ) : null}
            </Section>

            <Section title={t('backlog.title', { count: backlogTasks.length })}>
              <NewTaskButton projectId={projectId} />
              <div className="grid gap-1">
                {backlogTasks.map((task) => (
                  <TaskRow key={task.id} moveTargets={moveTargets} task={task} />
                ))}
              </div>
            </Section>

            {completed.length > 0 ? (
              <Section title={t('backlog.completed')}>
                <div className="grid gap-2">
                  {completed.map((iteration) => (
                    <div
                      key={iteration.id}
                      className="flex items-center gap-2 rounded-md bg-[color:var(--sb)] px-3 py-2 text-xs text-[color:var(--tx3)]"
                    >
                      <span className="font-semibold text-[color:var(--tx2)]">{iteration.name}</span>
                      <span>
                        {t('backlog.pointsDelivered', { done: iteration.pointsDone, total: iteration.pointsTotal })}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}
          </>
        )}
      </QueryState>
    </PageBody>
  )
}
