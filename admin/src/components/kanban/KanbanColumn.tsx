import { useDroppable } from '@dnd-kit/core'
import type { ReactNode } from 'react'

type KanbanColumnProps = {
  columnId: string
  label: string
  dot: string
  count: number
  children: ReactNode
  headerAction?: ReactNode
  // Columns outside the current page are hidden (display:none) so the visible
  // ones flex to fill the viewport. Width policy lives in KanbanBoard.
  visible: boolean
}

export const KanbanColumn = ({
  columnId,
  label,
  dot,
  count,
  children,
  headerAction,
  visible,
}: KanbanColumnProps) => {
  const { setNodeRef, isOver } = useDroppable({ id: columnId })

  return (
    <div
      className={[
        visible ? 'flex' : 'hidden',
        'min-w-[300px] flex-1 flex-col',
      ].join(' ')}
      data-kanban-column={columnId}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="h-2 w-2 rounded-full" style={{ background: dot }} />
        <span className="truncate text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx2)]">
          {label}
        </span>
        <span className="text-xs text-[color:var(--tx3)]">{count}</span>
        {headerAction ? <div className="ml-auto">{headerAction}</div> : null}
      </div>
      <div
        ref={setNodeRef}
        className={[
          'flex min-h-[120px] flex-1 flex-col gap-2 rounded-lg p-2 transition-colors',
          isOver ? 'bg-[color:var(--overlay)]' : 'bg-[color:var(--sb)]',
        ].join(' ')}
        data-kanban-dropzone={columnId}
      >
        {children}
      </div>
    </div>
  )
}
