import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskRecord } from '../../facades/tasks/hooks'
import { statusLabel } from './kanban-config'
import { PRIORITY_LABEL, PRIORITY_SIGNAL, formatDueDate, isOverdue } from './task-meta'

type KanbanCardProps = {
  task: TaskRecord
  showProject: boolean
  projectName: string | null
  archived?: boolean
  onOpen: (task: TaskRecord) => void
  // Pulse the card briefly after it lands in a column from a drag.
  pulse?: boolean
  onPulseEnd?: () => void
}

const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold'

const KanbanCardContent = ({
  task,
  showProject,
  projectName,
  archived,
}: Pick<KanbanCardProps, 'task' | 'showProject' | 'projectName' | 'archived'>) => (
  <>
    {showProject && projectName ? (
      <span className={`${chip} justify-self-start bg-[color:var(--overlay)] uppercase tracking-[0.14em] text-[color:var(--tx3)]`}>
        {projectName}
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

    <div className="flex items-center gap-1.5">
      <FontAwesomeIcon
        className={`shrink-0 text-xs ${PRIORITY_SIGNAL[task.priority]}`}
        icon={faSignal}
        title={`${PRIORITY_LABEL[task.priority]} priority`}
      />
      <span className={`${chip} max-w-[11rem] truncate bg-[color:var(--overlay)] text-[color:var(--tx2)]`}>
        {task.assigneeName ?? 'Unassigned'}
      </span>
      {task.dueDate || archived ? (
        <span className="ml-auto flex items-center gap-1.5">
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
        </span>
      ) : null}
    </div>
  </>
)

export const KanbanCard = ({
  task,
  showProject,
  projectName,
  archived = false,
  onOpen,
  pulse = false,
  onPulseEnd,
}: KanbanCardProps) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: archived,
  })

  // Distinguish a click (open the dialog) from a drag (move the card): record the
  // pointer-down position and only open if the pointer barely moved. The dnd
  // sensor activators come from `listeners` (mousedown / touchstart) — touch drag
  // is long-press activated, so a short touch swipe pages the board instead.
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    downAt.current = { x: event.clientX, y: event.clientY }
  }
  const handleClick = (event: { clientX: number; clientY: number }) => {
    const start = downAt.current
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
    onOpen(task)
  }

  // The card itself follows the pointer (no separate drag overlay), so its
  // position is always correct regardless of page scroll. Raise it while dragging.
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-kanban-card
      className={[
        'admin-card grid select-none gap-2 p-3 transition-shadow',
        archived ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        isDragging ? 'relative z-50 shadow-xl' : '',
        pulse ? 'kanban-card-pulse' : '',
      ].join(' ')}
      onAnimationEnd={pulse ? onPulseEnd : undefined}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      style={{ ...style, touchAction: 'none' }}
    >
      <KanbanCardContent archived={archived} projectName={projectName} showProject={showProject} task={task} />
    </div>
  )
}
