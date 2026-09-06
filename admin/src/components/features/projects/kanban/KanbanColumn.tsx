import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { ReactNode } from 'react'

type KanbanColumnProps = {
  columnId: string
  label: string
  dot: string
  count: number
  children: ReactNode
  headerAction?: ReactNode
  // Ordered task ids in this column — the SortableContext items for reordering.
  itemIds: string[]
}

export const KanbanColumn = ({
  columnId,
  label,
  dot,
  count,
  children,
  headerAction,
  itemIds,
}: KanbanColumnProps) => {
  // The column is itself a drop target so cards can be dropped into an empty
  // column or below the last card.
  const { setNodeRef, isOver } = useDroppable({ id: columnId })

  return (
    <div
      className="flex min-w-[300px] flex-1 flex-col"
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
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </div>
    </div>
  )
}
