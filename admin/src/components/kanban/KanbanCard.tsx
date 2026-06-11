import { useDraggable } from '@dnd-kit/core'
import type { AssignableUser, TaskRecord } from '../../facades/tasks/hooks'
import { statusLabel } from './kanban-config'

type KanbanCardProps = {
  task: TaskRecord
  assignees: AssignableUser[]
  showProject: boolean
  projectName: string | null
  archived?: boolean
  onReassign: (id: string, assigneeUserId: string | null) => void
  onSetStatus: (id: string, status: TaskRecord['status']) => void
}

const stopDrag = (event: { stopPropagation: () => void }) => event.stopPropagation()

export const KanbanCard = ({
  task,
  assignees,
  showProject,
  projectName,
  archived = false,
  onReassign,
  onSetStatus,
}: KanbanCardProps) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: archived,
  })

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.4 : 1 }
    : undefined

  return (
    <div
      ref={setNodeRef}
      className="admin-card grid gap-2 p-3"
      style={{ ...style, touchAction: 'none' }}
    >
      <div
        {...listeners}
        {...attributes}
        className={archived ? '' : 'cursor-grab active:cursor-grabbing'}
      >
        {showProject ? (
          <span
            className={[
              'mb-1 inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]',
              'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
            ].join(' ')}
          >
            {projectName ?? 'Unassigned'}
          </span>
        ) : null}
        <div className="truncate text-sm font-semibold text-[color:var(--tx)]">
          {task.title ?? task.purpose ?? 'Untitled task'}
        </div>
        {task.purpose && task.title ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-[color:var(--tx2)]">{task.purpose}</div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <select
          className="admin-input min-w-0 flex-1 py-1 text-xs"
          disabled={archived}
          onChange={(event) => onReassign(task.id, event.target.value || null)}
          onPointerDown={stopDrag}
          value={task.assigneeUserId ?? ''}
        >
          <option value="">Unassigned</option>
          {assignees.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        </select>

        {archived ? (
          <button
            className="admin-button admin-button-secondary py-1 text-xs"
            onClick={() => onSetStatus(task.id, 'inbox')}
            onPointerDown={stopDrag}
            type="button"
          >
            Restore
          </button>
        ) : (
          <button
            className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
            onClick={() => onSetStatus(task.id, 'cancelled')}
            onPointerDown={stopDrag}
            title="Cancel task"
            type="button"
          >
            Cancel
          </button>
        )}
      </div>

      {archived ? (
        <span className="text-[10px] uppercase tracking-[0.14em] text-[color:var(--tx3)]">
          {statusLabel(task.status)}
        </span>
      ) : null}
    </div>
  )
}
