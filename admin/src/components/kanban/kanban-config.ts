import type { ColumnCategory } from '../../facades/board/hooks'
import type { TaskRecord, TaskStatus } from '../../facades/tasks/hooks'

// A column the board renders. For a project board these come from the API
// (id = BoardColumn.id). For the aggregate (all-projects) board they are
// synthetic, with id = the category itself.
export type BoardColumnView = {
  id: string
  name: string
  category: ColumnCategory
}

export const CATEGORY_ORDER: ColumnCategory[] = ['todo', 'in_progress', 'review', 'done']

export const CATEGORY_LABEL: Record<ColumnCategory, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

export const CATEGORY_DOT: Record<ColumnCategory, string> = {
  todo: 'var(--tx3)',
  in_progress: 'var(--info-text)',
  review: 'var(--warning-text)',
  done: 'var(--success-text)',
}

// The canonical status a card takes when dropped into a column of this category.
export const CATEGORY_TO_STATUS: Record<ColumnCategory, TaskStatus> = {
  todo: 'inbox',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
}

// failed/cancelled never get a column; they live behind the Archive toggle.
export const ARCHIVED_STATUSES: TaskStatus[] = ['failed', 'cancelled']

export const statusToCategory = (status: TaskStatus): ColumnCategory | null => {
  switch (status) {
    case 'inbox':
    case 'assigned':
      return 'todo'
    case 'in_progress':
      return 'in_progress'
    case 'review':
    case 'awaiting_approval':
      return 'review'
    case 'done':
      return 'done'
    default:
      return null // failed / cancelled
  }
}

// The synthetic columns for the aggregate (all-projects) board.
export const AGGREGATE_COLUMNS: BoardColumnView[] = CATEGORY_ORDER.map((category) => ({
  id: category,
  name: CATEGORY_LABEL[category],
  category,
}))

export const statusLabel = (status: TaskStatus): string => status.replace(/_/g, ' ')

// Which column a task renders in: its pinned column when valid, otherwise the
// first column whose category matches the task's status. Null = archived.
export const placeTask = (
  task: Pick<TaskRecord, 'columnId' | 'status'>,
  columns: BoardColumnView[],
): string | null => {
  if (task.columnId && columns.some((column) => column.id === task.columnId)) {
    return task.columnId
  }
  const category = statusToCategory(task.status)
  if (!category) return null
  return columns.find((column) => column.category === category)?.id ?? null
}
