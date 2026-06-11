import type { TaskStatus } from '../../facades/tasks/hooks'

export type ColumnId = 'todo' | 'in_progress' | 'review' | 'done'

export type KanbanColumnDef = {
  id: ColumnId
  label: string
  // Statuses that render inside this column…
  statuses: TaskStatus[]
  // …and the canonical status a card takes when dropped here.
  target: TaskStatus
  // Token-driven accent for the column header dot.
  dot: string
}

export const KANBAN_COLUMNS: KanbanColumnDef[] = [
  {
    id: 'todo',
    label: 'To do',
    statuses: ['inbox', 'assigned'],
    target: 'inbox',
    dot: 'var(--tx3)',
  },
  {
    id: 'in_progress',
    label: 'In progress',
    statuses: ['in_progress'],
    target: 'in_progress',
    dot: 'var(--info-text)',
  },
  {
    id: 'review',
    label: 'Review',
    statuses: ['review', 'awaiting_approval'],
    target: 'review',
    dot: 'var(--warning-text)',
  },
  {
    id: 'done',
    label: 'Done',
    statuses: ['done'],
    target: 'done',
    dot: 'var(--success-text)',
  },
]

// failed/cancelled never get a board column; they live behind the Archive toggle.
export const ARCHIVED_STATUSES: TaskStatus[] = ['failed', 'cancelled']

export const columnForStatus = (status: TaskStatus): ColumnId | null =>
  KANBAN_COLUMNS.find((column) => column.statuses.includes(status))?.id ?? null

export const statusLabel = (status: TaskStatus): string => status.replace(/_/g, ' ')
