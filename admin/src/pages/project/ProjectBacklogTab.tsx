import { useMemo, useState } from 'react'
import { ARCHIVED_STATUSES, statusLabel } from '../../components/kanban/kanban-config'
import { NewTaskButton } from '../../components/kanban/NewTaskButton'
import { taskStatusTone } from '../../components/kanban/task-status-presentation'
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
import { useIsOwner } from '../../components/shared/OwnerGate'

const PointsInput = ({ task }: { task: TaskRecord }) => {
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
      aria-label="Story points"
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
  const setIteration = useSetTaskIteration()
  return (
    <div className="flex items-center gap-2 rounded-md bg-[color:var(--sb)] px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]">
        {task.title ?? task.purpose ?? 'Untitled task'}
      </span>
      <Pill size="sm" tone={taskStatusTone(task.status)}>
        {statusLabel(task.status)}
      </Pill>
      <PointsInput task={task} />
      <select
        aria-label="Move to sprint"
        className="admin-input admin-input-compact max-w-[150px]"
        onChange={(event) =>
          setIteration.mutate({ id: task.id, iterationId: event.target.value || null })
        }
        value={task.iterationId ?? ''}
      >
        <option value="">Backlog</option>
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
  isOwner,
  tasks,
  moveTargets,
}: {
  iteration: Iteration
  projectId: string
  isOwner: boolean
  tasks: TaskRecord[]
  moveTargets: { id: string; name: string }[]
}) => {
  const update = useUpdateIteration(projectId)
  const remove = useDeleteIteration(projectId)
  const [deleteOpen, setDeleteOpen] = useState(false)

  return (
    <>
      <div className="admin-card grid gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-[color:var(--tx)]">{iteration.name}</span>
          <Pill size="sm">{iteration.status}</Pill>
          <span className="text-xs text-[color:var(--tx3)]">
            {iteration.pointsDone}/{iteration.pointsTotal} pts · {iteration.taskCount} tasks
          </span>
          {isOwner ? (
            <div className="ml-auto flex gap-2">
              {iteration.status === 'planned' ? (
                <button
                  className="admin-button admin-button-primary admin-button-compact"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: iteration.id, action: 'start' })}
                  type="button"
                >
                  Start
                </button>
              ) : null}
              {iteration.status === 'active' ? (
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: iteration.id, action: 'complete' })}
                  type="button"
                >
                  Complete
                </button>
              ) : null}
              <button
                className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
                onClick={() => setDeleteOpen(true)}
                type="button"
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
        {iteration.goal ? (
          <div className="text-xs text-[color:var(--tx2)]">{iteration.goal}</div>
        ) : null}
        <div className="grid gap-1">
          {tasks.length === 0 ? (
            <div className="text-xs text-[color:var(--tx3)]">No tasks in this iteration.</div>
          ) : (
            tasks.map((task) => <TaskRow key={task.id} moveTargets={moveTargets} task={task} />)
          )}
        </div>
      </div>

      <ConfirmDialog
        body="Its tasks return to the backlog."
        confirmLabel="Delete"
        destructive
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          setDeleteOpen(false)
          remove.mutate(iteration.id)
        }}
        open={deleteOpen}
        title={`Delete "${iteration.name}"?`}
      />
    </>
  )
}

type ProjectBacklogTabProps = {
  projectId: string
}

export const ProjectBacklogTab = ({ projectId }: ProjectBacklogTabProps) => {
  const isOwner = useIsOwner()
  const iterationsQuery = useIterations(projectId)
  const tasksQuery = useTasks(projectId)
  const iterations = iterationsQuery.data ?? []
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

  const visibleTasks = tasks.filter((task) => !ARCHIVED_STATUSES.includes(task.status))
  const backlogTasks = visibleTasks.filter((task) => !task.iterationId)
  const tasksByIteration = (iterationId: string) =>
    visibleTasks.filter((task) => task.iterationId === iterationId)

  const handleCreate = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    createIteration.mutate({ name: trimmed }, { onSuccess: () => setNewName('') })
  }

  return (
    <PageBody width="regular">
      <QueryState
        errorLabel="Couldn't load the backlog."
        loadingLabel="Loading backlog…"
        query={backlogQuery}
      >
        {() => (
          <>
            <Section title="Sprints">
              {planning.length === 0 ? (
                <div className="text-xs text-[color:var(--tx3)]">No sprints yet.</div>
              ) : (
                <div className="grid gap-2">
                  {planning.map((iteration) => (
                    <IterationCard
                      key={iteration.id}
                      isOwner={isOwner}
                      iteration={iteration}
                      moveTargets={moveTargets}
                      projectId={projectId}
                      tasks={tasksByIteration(iteration.id)}
                    />
                  ))}
                </div>
              )}
              {isOwner ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    handleCreate()
                  }}
                >
                  <Input
                    aria-label="Sprint name"
                    className="min-w-0 flex-1"
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="New sprint name…"
                    size="compact"
                    value={newName}
                  />
                  <button
                    className="admin-button admin-button-primary admin-button-compact"
                    disabled={!newName.trim() || createIteration.isPending}
                    type="submit"
                  >
                    Add sprint
                  </button>
                </form>
              ) : null}
            </Section>

            <Section title={`Backlog (${backlogTasks.length})`}>
              <NewTaskButton projectId={projectId} />
              <div className="grid gap-1">
                {backlogTasks.map((task) => (
                  <TaskRow key={task.id} moveTargets={moveTargets} task={task} />
                ))}
              </div>
            </Section>

            {completed.length > 0 ? (
              <Section title="Completed">
                <div className="grid gap-2">
                  {completed.map((iteration) => (
                    <div
                      key={iteration.id}
                      className="flex items-center gap-2 rounded-md bg-[color:var(--sb)] px-3 py-2 text-xs text-[color:var(--tx3)]"
                    >
                      <span className="font-semibold text-[color:var(--tx2)]">{iteration.name}</span>
                      <span>
                        {iteration.pointsDone}/{iteration.pointsTotal} pts delivered
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
