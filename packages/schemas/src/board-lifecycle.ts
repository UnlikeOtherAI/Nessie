import { z } from 'zod'

/**
 * The lifecycle vocabulary a board column maps onto, and the two maps between
 * it and `TaskStatus`.
 *
 * These lived in two places that had to agree and did not: the client's
 * `admin/src/components/kanban/kanban-config.ts` (`statusToCategory`) and the
 * server's `packages/team-admin/src/project-task-move.ts`
 * (`CATEGORY_TO_STATUS`). With boards resolving placement server-side
 * (`resolveBoardPlacement`) and the admin only grouping the result, both
 * import this module instead.
 */

export const ColumnCategorySchema = z.enum(['todo', 'in_progress', 'review', 'done'])
export type ColumnCategory = z.infer<typeof ColumnCategorySchema>

export const COLUMN_CATEGORIES: readonly ColumnCategory[] =
  ColumnCategorySchema.options

/**
 * `failed` and `cancelled` never get a column — they live behind the board's
 * Archived toggle, together with anything carrying `archivedAt`.
 */
export const ARCHIVED_STATUSES = ['failed', 'cancelled'] as const
export type ArchivedStatus = (typeof ARCHIVED_STATUSES)[number]

export const isArchivedStatus = (status: string): boolean =>
  (ARCHIVED_STATUSES as readonly string[]).includes(status)

/**
 * Which category a status renders in, or `null` when the work belongs in
 * Archived rather than on any column.
 */
export const statusToCategory = (status: string): ColumnCategory | null => {
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

/**
 * The status a move into a column of this category asks for. The transition is
 * still validated against `VALID_TRANSITIONS` before it is written.
 */
export const CATEGORY_TO_STATUS = {
  todo: 'inbox',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
} as const satisfies Record<ColumnCategory, string>

export const categoryToStatus = (category: ColumnCategory): string =>
  CATEGORY_TO_STATUS[category]
