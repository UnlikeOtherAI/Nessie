import { useMemo, useState } from 'react'
import { ARCHIVED_STATUSES, statusLabel } from '../../components/kanban/kanban-config'
import { NewTaskButton } from '../../components/kanban/NewTaskButton'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
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

const label = 'text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]'

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
      <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[color:var(--tx3)]">
        {statusLabel(task.status)}
      </span>
      <PointsInput task={task} />
      <select
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
  const { data: iterations = [] } = useIterations(projectId)
  const { data: tasks = [] } = useTasks(projectId)
  const createIteration = useCreateIteration(projectId)
  const [newName, setNewName] = useState('')

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
    <div className="min-h-0 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-3xl gap-6">
        <section className="grid gap-2">
          <div className={label}>Sprints</div>
          {planning.length === 0 ? (
            <div className="text-xs text-[color:var(--tx3)]">No sprints yet.</div>
          ) : (
            planning.map((iteration) => (
              <IterationCard
                key={iteration.id}
                isOwner={isOwner}
                iteration={iteration}
                moveTargets={moveTargets}
                projectId={projectId}
                tasks={tasksByIteration(iteration.id)}
              />
            ))
          )}
          {isOwner ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                handleCreate()
              }}
            >
              <input
                className="admin-input admin-input-compact min-w-0 flex-1"
                onChange={(event) => setNewName(event.target.value)}
                placeholder="New sprint name…"
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
        </section>

        <section className="grid gap-2">
          <div className={label}>Backlog ({backlogTasks.length})</div>
          <NewTaskButton projectId={projectId} />
          <div className="grid gap-1">
            {backlogTasks.map((task) => (
              <TaskRow key={task.id} moveTargets={moveTargets} task={task} />
            ))}
          </div>
        </section>

        {completed.length > 0 ? (
          <section className="grid gap-2">
            <div className={label}>Completed</div>
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
          </section>
        ) : null}
      </div>
    </div>
  )
}
