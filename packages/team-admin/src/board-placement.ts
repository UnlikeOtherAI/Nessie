import type { PrismaClient } from '@prisma/client'
import {
  COLUMN_CATEGORIES,
  type BoardFilter,
  type BoardRecord,
  type ColumnCategory,
  statusToCategory,
} from '@nessie/schemas'
import type { Prisma } from '@prisma/client'

import {
  mapProjectTask,
  projectTaskInclude,
  type ProjectTaskRecord,
} from './project-task-records.js'

/**
 * Which tasks a board holds, and where each one renders on it.
 *
 * A board *owns* its tasks (`Task.boardId`). Boards used to be N saved views
 * over one project pool, which meant every board of a project drew the same
 * cards — a "Dev" board beside "Board" showed the same ticket twice, and
 * nothing a person did on one board could make the two differ. Ownership is
 * what makes a second board worth creating; `boardTaskPoolWhere` is the one
 * place that decides which board a task belongs to.
 *
 * Placement within the board is still derived, never stored: `Task.status` is
 * the one lifecycle truth and a `TaskBoardPlacement` is a pin over it. The pin
 * is ignored once its column's category no longer matches the status — this
 * rule used to live in the client (`kanban-config.ts` `placeTask`), where a
 * card dragged into "In progress" that an agent run then completed stayed
 * drawn in "In progress" while its status was `done`.
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

const byPosition = (a: PlacementColumn, b: PlacementColumn) => a.position - b.position

/**
 * The board's columns of one category, in display order.
 */
const columnsOfCategory = (
  columns: readonly PlacementColumn[],
  category: string,
): PlacementColumn[] => columns.filter((column) => column.category === category).sort(byPosition)

/**
 * The stage a board shows work that is at a stage this board does not model.
 *
 * A board need not carry all four categories — three columns is a normal
 * board — but now that the board *owns* the task, "no column of this category"
 * can no longer mean "not on this board": the card would exist nowhere. So it
 * falls back to the nearest stage the board does model, preferring an earlier
 * one so a board never claims work is further along than it is.
 */
const nearestColumn = (
  columns: readonly PlacementColumn[],
  category: ColumnCategory,
): PlacementColumn | undefined => {
  const index = COLUMN_CATEGORIES.indexOf(category)
  if (index < 0) return undefined
  const earlier = COLUMN_CATEGORIES.slice(0, index).reverse()
  const later = COLUMN_CATEGORIES.slice(index + 1)
  for (const candidate of [...earlier, ...later]) {
    const column = columnsOfCategory(columns, candidate)[0]
    if (column) return column
  }
  return undefined
}

/**
 * The rule itself, over already-loaded data so it stays pure and testable.
 * The caller has already decided the task belongs to this board.
 *
 * - Archived work (`failed`, `cancelled`) belongs to no column on any board.
 * - A pin whose column has drifted out of the task's category is ignored, not
 *   honoured.
 * - A category this board has no column for falls back to `nearestColumn`, so
 *   the board's own work is always somewhere a person can see it.
 */
export const resolveBoardPlacement = (
  task: { status: string; archivedAt: Date | string | null },
  columns: readonly PlacementColumn[],
  pin: PlacementPin | undefined,
): BoardPlacement => {
  if (task.archivedAt) return null
  const category = statusToCategory(task.status)
  if (!category) return null

  const ofCategory = columnsOfCategory(columns, category)
  if (ofCategory.length === 0) {
    const nearest = nearestColumn(columns, category)
    return nearest ? { columnId: nearest.id, position: null } : null
  }

  if (pin) {
    const pinned = ofCategory.find((column) => column.id === pin.columnId)
    if (pinned) return { columnId: pinned.id, position: pin.position }
  }
  const first = ofCategory[0]
  return first ? { columnId: first.id, position: null } : null
}

/**
 * The tasks one board holds.
 *
 * `Task.boardId` names the board; `null` is "the project's default board", so
 * every task written by something that knows nothing about boards — an agent
 * run, a trigger, an inbound email, an external source sync — lands on the
 * board the project opens on rather than nowhere. Deleting a board sets its
 * tasks' `board_id` back to NULL (`ON DELETE SET NULL`), which returns the
 * work to the default board instead of destroying it.
 */
export const boardTaskPoolWhere = (board: {
  id: string
  isDefault: boolean
}): Prisma.TaskWhereInput =>
  board.isDefault ? { OR: [{ boardId: board.id }, { boardId: null }] } : { boardId: board.id }

/**
 * Every task this board owns, placed into its columns.
 *
 * Archived work comes back with `columnId: null` so the board's existing
 * Archived strip keeps rendering; a scrum board is narrowed to one iteration
 * by the caller, because iterations are a project-level time box that any
 * board may or may not care about. The board's `filter` still narrows — it now
 * narrows the board's own tasks rather than the whole project's.
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
      AND: [boardTaskPoolWhere(board), boardFilterWhere(board.filter)],
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
    // Only a board with no columns at all leaves its own work unplaced, and
    // that board's surface says so. The card still comes back — under the
    // Archived strip rather than nowhere.
    if (!placement) {
      placed.push({ ...mapProjectTask(task), columnId: null, position: null })
      continue
    }
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

  // `native` is "has no external link"; a list of ids is "linked to one of
  // these". `all` narrows nothing, which is why it is the default.
  if (filter.sources === 'native') {
    clauses.push({ externalLink: { is: null } })
  } else if (Array.isArray(filter.sources)) {
    clauses.push({ externalLink: { is: { sourceId: { in: filter.sources } } } })
  }

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
