import { useMemo, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  type AssignableUser,
  type TaskRecord,
  useAssignTask,
  useTransitionTask,
} from '../../facades/tasks/hooks'
import { KanbanCard } from './KanbanCard'
import { KanbanColumn } from './KanbanColumn'
import {
  ARCHIVED_STATUSES,
  type BoardColumnView,
  CATEGORY_DOT,
  placeTask,
} from './kanban-config'

type KanbanBoardProps = {
  columns: BoardColumnView[]
  tasks: TaskRecord[]
  assignees: AssignableUser[]
  showProject: boolean
  projectNameById: Record<string, string>
  // Drag handler: the parent decides whether this is a /move (project board) or
  // a status transition (aggregate board).
  onMoveTask: (taskId: string, columnId: string) => void
}

export const KanbanBoard = ({
  columns,
  tasks,
  assignees,
  showProject,
  projectNameById,
  onMoveTask,
}: KanbanBoardProps) => {
  const transition = useTransitionTask()
  const assign = useAssignTask()
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const { byColumn, archived } = useMemo(() => {
    const grouped: Record<string, TaskRecord[]> = Object.fromEntries(columns.map((c) => [c.id, []]))
    const archivedTasks: TaskRecord[] = []
    for (const task of tasks) {
      const columnId = placeTask(task, columns)
      if (columnId && grouped[columnId]) grouped[columnId].push(task)
      else if (ARCHIVED_STATUSES.includes(task.status)) archivedTasks.push(task)
    }
    return { byColumn: grouped, archived: archivedTasks }
  }, [tasks, columns])

  const handleReassign = (id: string, assigneeUserId: string | null) => {
    setError(null)
    assign.mutate({ id, assigneeUserId }, { onError: (e) => setError(e.message) })
  }

  const handleSetStatus = (id: string, status: TaskRecord['status']) => {
    setError(null)
    transition.mutate({ id, status }, { onError: (e) => setError(e.message) })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const columnId = String(over.id)
    const task = tasks.find((t) => t.id === String(active.id))
    if (!task || placeTask(task, columns) === columnId) return
    setError(null)
    onMoveTask(task.id, columnId)
  }

  const cardProps = (task: TaskRecord) => ({
    assignees,
    onReassign: handleReassign,
    onSetStatus: handleSetStatus,
    projectName: task.projectId ? projectNameById[task.projectId] ?? null : null,
    showProject,
    task,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div className="admin-card mb-3 border-[color:var(--danger-border)] p-2 text-xs text-[color:var(--danger-text)]">
          {error}
        </div>
      ) : null}

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              columnId={column.id}
              count={byColumn[column.id]?.length ?? 0}
              dot={CATEGORY_DOT[column.category]}
              label={column.name}
            >
              {(byColumn[column.id] ?? []).map((task) => (
                <KanbanCard key={task.id} {...cardProps(task)} />
              ))}
            </KanbanColumn>
          ))}
        </div>
      </DndContext>

      <div className="mt-3 border-t border-[color:var(--sep)] pt-3">
        <button
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
          onClick={() => setShowArchived((value) => !value)}
          type="button"
        >
          <span>{showArchived ? '▾' : '▸'}</span>
          Archived ({archived.length})
        </button>
        {showArchived ? (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {archived.length === 0 ? (
              <div className="text-xs text-[color:var(--tx3)]">No cancelled or failed work.</div>
            ) : (
              archived.map((task) => <KanbanCard key={task.id} {...cardProps(task)} archived />)
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
