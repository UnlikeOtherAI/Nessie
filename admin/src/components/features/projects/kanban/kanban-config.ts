import type { ColumnCategory } from '@nessie/schemas'

/**
 * Board presentation constants.
 *
 * The lifecycle *rule* — which column a task belongs in — is no longer here.
 * It moved to the server (`resolveBoardPlacement` in `@nessie/team-admin`)
 * when a project gained many boards: the client cannot resolve placement for a
 * board it is not rendering, and the old client-side `placeTask` honoured a
 * pinned column without checking its category still matched the task's status,
 * so a card an agent completed stayed in "In progress". The board read now
 * arrives already placed and this module only decides how it looks.
 */

export { isArchivedStatus, statusToCategory } from '@nessie/schemas'
export type { ColumnCategory }

/** A column the board renders; `id` is `BoardColumn.id`. */
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

export const statusLabel = (status: string): string => status.replace(/_/g, ' ')
