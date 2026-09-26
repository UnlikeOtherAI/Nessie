import type { ColumnCategory } from '@nessie/schemas'
import type { TFunction } from 'i18next'

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

export const statusLabel = (status: string, t: TFunction<'projects'>): string => {
  switch (status) {
    case 'inbox': return t('task.status.inbox')
    case 'assigned': return t('task.status.assigned')
    case 'in_progress': return t('task.status.in_progress')
    case 'review': return t('task.status.review')
    case 'awaiting_approval': return t('task.status.awaiting_approval')
    case 'done': return t('task.status.done')
    case 'failed': return t('task.status.failed')
    case 'cancelled': return t('task.status.cancelled')
    default: return status.replace(/_/g, ' ')
  }
}
