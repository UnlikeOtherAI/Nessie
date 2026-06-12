import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { TaskRecord } from '../../facades/tasks/hooks'
import { statusLabel } from './kanban-config'
import { PRIORITY_CHIP, PRIORITY_LABEL, formatDueDate, isOverdue } from './task-meta'

type KanbanCardProps = {
  task: TaskRecord
  showProject: boolean
  projectName: string | null
  archived?: boolean
  onOpen: (task: TaskRecord) => void
}

const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold'

export const KanbanCard = ({ task, showProject, projectName, archived = false, onOpen }: KanbanCardProps) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: archived,
  })

  // Distinguish a click (open the dialog) from a drag (move the card): record the
  // pointer-down position and only open if the pointer barely moved.
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    downAt.current = { x: event.clientX, y: event.clientY }
    listeners?.onPointerDown?.(event)
  }
  const handleClick = (event: { clientX: number; clientY: number }) => {
    const start = downAt.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    onOpen(task)
  }

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.4 : 1 }
    : undefined

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      className={[
        'admin-card grid gap-2 p-3',
        archived ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
      ].join(' ')}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      style={{ ...style, touchAction: 'none' }}
    >
      {showProject ? (
        <span className={`${chip} justify-self-start bg-[color:var(--overlay)] uppercase tracking-[0.14em] text-[color:var(--tx3)]`}>
          {projectName ?? 'Unassigned'}
        </span>
      ) : null}

      <div className="break-words text-sm font-semibold leading-snug text-[color:var(--tx)] line-clamp-3">
        {task.title ?? task.purpose ?? 'Untitled task'}
      </div>
      {task.purpose && task.title ? (
        <div className="break-words text-xs leading-snug text-[color:var(--tx2)] line-clamp-3">
          {task.purpose}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${chip} ${PRIORITY_CHIP[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
        {task.dueDate ? (
          <span
            className={[
              chip,
              isOverdue(task.dueDate)
                ? 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]'
                : 'bg-[color:var(--overlay)] text-[color:var(--tx2)]',
            ].join(' ')}
          >
            {formatDueDate(task.dueDate)}
          </span>
        ) : null}
        {archived ? (
          <span className={`${chip} bg-[color:var(--overlay)] uppercase tracking-[0.14em] text-[color:var(--tx3)]`}>
            {statusLabel(task.status)}
          </span>
        ) : null}
        {task.assigneeName ? (
          <span className="ml-auto truncate text-[11px] text-[color:var(--tx3)]">{task.assigneeName}</span>
        ) : null}
      </div>
    </div>
  )
}
