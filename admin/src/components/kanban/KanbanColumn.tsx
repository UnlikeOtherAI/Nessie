import { useDroppable } from '@dnd-kit/core'
import type { ReactNode } from 'react'
import type { KanbanColumnDef } from './kanban-config'

type KanbanColumnProps = {
  column: KanbanColumnDef
  count: number
  children: ReactNode
}

export const KanbanColumn = ({ column, count, children }: KanbanColumnProps) => {
  const { setNodeRef, isOver } = useDroppable({ id: column.id })

  return (
    <div className="flex w-[280px] min-w-[280px] flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: column.dot }}
        />
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx2)]">
          {column.label}
        </span>
        <span className="text-xs text-[color:var(--tx3)]">{count}</span>
      </div>
      <div
        ref={setNodeRef}
        className={[
          'flex min-h-[120px] flex-1 flex-col gap-2 rounded-lg p-2 transition-colors',
          isOver ? 'bg-[color:var(--overlay)]' : 'bg-[color:var(--sb)]',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  )
}
