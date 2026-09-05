import type { PrismaClient } from '@prisma/client'
import { type BoardFilter, type BoardRecord, statusToCategory } from '@nessie/schemas'
import type { Prisma } from '@prisma/client'

import {
  mapProjectTask,
  projectTaskInclude,
  type ProjectTaskRecord,
} from './project-task-records.js'

/**
 * Where a task renders on a given board.
 *
 * This rule used to live in the client (`admin/src/components/kanban/
 * kanban-config.ts` `placeTask`), where it had a latent bug: it honoured a
 * pinned column whenever that column still *existed*, without checking that
 * the column's category still matched the task's status. A card somebody
 * dragged into "In progress" that an agent run then completed stayed rendered
 * in "In progress" while its status was `done`.
 *
 * With N boards over one task pool the rule has to be server-side anyway — the
 * client cannot know a board's columns for a board it is not showing — so it
 * moved here and the staleness check came with it. `Task.status` remains the
 * one lifecycle truth; a placement is a pin over it, never a substitute.
 */

export type BoardTaskRecord = ProjectTaskRecord & {
  /** The column this task renders in on this board; null ⇒ Archived strip. */
  columnId: string | null
  /** Explicit order within the column; null ⇒ ordered by `updatedAt desc`. */
  position: number | null
}

export type BoardPlacement = { columnId: string; position: number | null } | null

type PlacementPin = { columnId: string; position: number }

/**
 * The shape the rule needs from a column. Structural rather than
 * `Pick<BoardColumnRecord, …>` so a narrow Prisma `select` satisfies it
 * without first being mapped into a branded record.
 */
export type PlacementColumn = { id: string; category: string; position: number }

/**
 * The rule itself, over already-loaded data so it stays pure and testable.
 *
 * - Archived work (`failed`, `cancelled`) belongs to no column on any board.
 * - A board with no column of the task's category simply does not show it —
 *   that is what makes a board's column set a filter, and how a "Review queue"
 *   board is built without any filter vocabulary at all.
 * - A pin whose column has drifted out of the task's category is ignored, not
 *   honoured.
 */
export const resolveBoardPlacement = (
  task: { status: string; archivedAt: Date | string | null },
  columns: readonly PlacementColumn[],
  pin: PlacementPin | undefined,
): BoardPlacement => {
  if (task.archivedAt) return null
  const category = statusToCategory(task.status)
  if (!category) return null

  const ofCategory = columns
    .filter((column) => column.category === category)
    .sort((a, b) => a.position - b.position)
  if (ofCategory.length === 0) return null

  if (pin) {
    const pinned = ofCategory.find((column) => column.id === pin.columnId)
    if (pinned) return { columnId: pinned.id, position: pin.position }
  }
  const first = ofCategory[0]
  return first ? { columnId: first.id, position: null } : null
}

/**
 * Every task of the board's project, placed for this board.
 *
 * Archived work comes back with `columnId: null` so the board's existing
 * Archived strip keeps rendering; a scrum board is narrowed to one iteration
 * by the caller, because iterations are a project-level time box that any
 * board may or may not care about.
 */
export const listBoardTasks = async (
  prisma: PrismaClient,
  board: BoardRecord,
  options: { limit: number; iterationId?: string | null },
): Promise<{ tasks: BoardTaskRecord[]; truncated: boolean }> => {
  const tasks = await prisma.task.findMany({
    where: {
      projectId: board.projectId,
      ...(options.iterationId !== undefined
        ? { iterationId: options.iterationId }
        : {}),
      ...boardFilterWhere(board.filter),
    },
    include: projectTaskInclude,
    orderBy: { updatedAt: 'desc' },
    take: options.limit + 1,
  })
  const truncated = tasks.length > options.limit
  const page = truncated ? tasks.slice(0, options.limit) : tasks

  const pins = await prisma.taskBoardPlacement.findMany({
    where: { boardId: board.id, taskId: { in: page.map((task) => task.id) } },
    select: { taskId: true, columnId: true, position: true },
  })
  const pinByTask = new Map(pins.map((pin) => [pin.taskId, pin]))

  const placed: BoardTaskRecord[] = []
  for (const task of page) {
    const archived = Boolean(task.archivedAt) || statusToCategory(task.status) === null
    if (archived) {
      placed.push({ ...mapProjectTask(task), columnId: null, position: null })
      continue
    }
    const placement = resolveBoardPlacement(task, board.columns, pinByTask.get(task.id))
    // No column of this task's category on this board: the task is off this
    // board entirely. That is what makes a board's column set a filter.
    if (!placement) continue
    placed.push({
      ...mapProjectTask(task),
      columnId: placement.columnId,
      position: placement.position,
    })
  }
  return { tasks: orderForRender(placed), truncated }
}

/**
 * Within each column: explicitly placed rows first, by their position, then
 * the rest in the `updatedAt desc` order they arrived in. Grouping keeps the
 * comparison a total order — sorting one flat array by a key that only exists
 * within a column is not one, and `Array.prototype.sort` is entitled to
 * scramble the result when it is handed an inconsistent comparator.
 */
export const orderForRender = (tasks: BoardTaskRecord[]): BoardTaskRecord[] => {
  const groups = new Map<string, BoardTaskRecord[]>()
  const order: string[] = []
  for (const task of tasks) {
    const key = task.columnId ?? '\u0000archived'
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
      order.push(key)
    }
    group.push(task)
  }
  return order.flatMap((key) => {
    const group = groups.get(key) ?? []
    const positioned = group
      .filter((task) => task.position !== null)
      .sort((a, b) => (a.position as number) - (b.position as number))
    const unpositioned = group.filter((task) => task.position === null)
    return [...positioned, ...unpositioned]
  })
}

/**
 * The board's filter as a Prisma `where` fragment.
 *
 * A `select` value is one option id and a `multi_select` value is an array of
 * them, so one containment test covers both: `field_values @> {"<id>": "<opt>"}`
 * matches the scalar and `field_values -> '<id>' ? '<opt>'` the array. Prisma's
 * JSON filters express exactly these two, and the `tasks_field_values_gin`
 * index serves them.
 */
export const boardFilterWhere = (filter: BoardFilter): Prisma.TaskWhereInput => {
  const clauses: Prisma.TaskWhereInput[] = []

  // `filter.sources` narrows to native or externally-mirrored work. Until a
  // source can be attached there are no mirrored tasks, so every value of it
  // selects the same set; the clause lands with `TaskExternalLink`.

  if (filter.field) {
    const { fieldId, optionIds } = filter.field
    clauses.push({
      OR: optionIds.flatMap((optionId) => [
        { fieldValues: { path: [fieldId], equals: optionId } },
        { fieldValues: { path: [fieldId], array_contains: optionId } },
      ]),
    })
  }

  return clauses.length === 0 ? {} : { AND: clauses }
}
