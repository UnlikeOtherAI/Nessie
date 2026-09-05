import type { Prisma, PrismaClient } from '@prisma/client'
import {
  type BoardColumnRecord,
  type BoardColumnStateBinding,
  BoardColumnStateBindingsSchema,
  type BoardFilter,
  BoardFilterSchema,
  type BoardRecord,
  type BoardStyle,
  type ColumnCategory,
  DEFAULT_BOARD_FILTER,
  parseBoardColumnId,
  parseBoardId,
  parseProjectId,
} from '@nessie/schemas'

/**
 * Boards and their columns — the shared implementation behind the API routes,
 * project creation (clicked and from chat), and the personal assistant's
 * `ticket_board_read`. A board is a *view*: deleting one deletes its columns
 * and placements, never a task.
 */

export const DEFAULT_BOARD_NAME = 'Board'

export const DEFAULT_BOARD_COLUMNS: {
  name: string
  category: ColumnCategory
}[] = [
  { name: 'To do', category: 'todo' },
  { name: 'In progress', category: 'in_progress' },
  { name: 'Review', category: 'review' },
  { name: 'Done', category: 'done' },
]

const defaultColumnRows = (organizationId: string) =>
  DEFAULT_BOARD_COLUMNS.map((column, index) => ({
    organizationId,
    name: column.name,
    category: column.category,
    position: index,
  }))

/**
 * Nested-create data for a project's default board, for use inside a
 * `prisma.project.create`. `projectId` is supplied by the parent create, so it
 * is omitted here — the same shape `defaultColumnCreateData` had before boards
 * existed.
 */
export const defaultBoardCreateData = (organizationId: string) => ({
  organizationId,
  name: DEFAULT_BOARD_NAME,
  isDefault: true,
  position: 0,
  columns: { create: defaultColumnRows(organizationId) },
})

/**
 * Give an existing project its default board when it has none. Idempotent, so
 * the bootstrap seed and the UOA team-target provisioner can both call it.
 */
export const seedDefaultBoard = async (
  tx: Prisma.TransactionClient,
  project: { id: string; organizationId: string },
): Promise<void> => {
  if ((await tx.board.count({ where: { projectId: project.id } })) > 0) return
  await tx.board.create({
    data: { projectId: project.id, ...defaultBoardCreateData(project.organizationId) },
  })
}

// ─── Reads ────────────────────────────────────────────────────────────────

const boardInclude = {
  columns: { orderBy: { position: 'asc' } },
} satisfies Prisma.BoardInclude

type BoardWithColumns = Prisma.BoardGetPayload<{ include: typeof boardInclude }>

const parseStateBindings = (value: unknown): BoardColumnStateBinding[] => {
  const parsed = BoardColumnStateBindingsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

const parseFilter = (value: unknown): BoardFilter => {
  const parsed = BoardFilterSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_BOARD_FILTER
}

export const mapBoardColumn = (column: {
  id: string
  boardId: string
  name: string
  category: ColumnCategory
  position: number
  stateBindings: unknown
}): BoardColumnRecord => ({
  id: parseBoardColumnId(column.id),
  boardId: parseBoardId(column.boardId),
  name: column.name,
  category: column.category,
  position: column.position,
  stateBindings: parseStateBindings(column.stateBindings),
})

export const mapBoard = (board: BoardWithColumns): BoardRecord => ({
  id: parseBoardId(board.id),
  projectId: parseProjectId(board.projectId),
  name: board.name,
  style: board.style,
  isDefault: board.isDefault,
  position: board.position,
  filter: parseFilter(board.filter),
  columns: board.columns.map(mapBoardColumn),
})

/**
 * Every board of a project, in display order, each with its columns. The one
 * read the board tab, project settings, the Overview section, the navigation
 * prewarm and `ticket_board_read` all share.
 *
 * Lazily seeds the default board for a project that somehow has none — the
 * behaviour `getProjectBoard` had for its columns before boards existed.
 */
export const listBoards = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
): Promise<BoardRecord[]> => {
  let boards = await prisma.board.findMany({
    where: { projectId: project.id },
    include: boardInclude,
    orderBy: { position: 'asc' },
  })
  if (boards.length === 0) {
    await seedDefaultBoard(prisma, project)
    boards = await prisma.board.findMany({
      where: { projectId: project.id },
      include: boardInclude,
      orderBy: { position: 'asc' },
    })
  }
  return boards.map(mapBoard)
}

/** The board a read with no `?board=` opens on, and the PA's implicit board. */
export const resolveDefaultBoard = (boards: BoardRecord[]): BoardRecord | null =>
  boards.find((board) => board.isDefault) ?? boards[0] ?? null

export const findBoard = async (
  prisma: PrismaClient,
  projectId: string,
  boardId: string,
): Promise<BoardRecord | null> => {
  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId },
    include: boardInclude,
  })
  return board ? mapBoard(board) : null
}

// ─── Board writes ─────────────────────────────────────────────────────────

export type BoardMutationError =
  | { error: 'BOARD_NOT_FOUND' }
  | { error: 'BOARD_LAST' }
  | { error: 'BOARD_DEFAULT_REPLACEMENT_REQUIRED' }
  | { error: 'COLUMN_NOT_FOUND' }
  | { error: 'SOURCE_STATE_UNKNOWN'; detail: string }

const isError = <T>(value: T | BoardMutationError): value is BoardMutationError =>
  typeof value === 'object' && value !== null && 'error' in value

export const createBoard = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  input: {
    name: string
    style?: BoardStyle
    copyColumnsFromBoardId?: string
    createdByUserId?: string
  },
): Promise<BoardRecord | BoardMutationError> => {
  let columns = defaultColumnRows(project.organizationId)
  if (input.copyColumnsFromBoardId) {
    const source = await prisma.board.findFirst({
      where: { id: input.copyColumnsFromBoardId, projectId: project.id },
      include: boardInclude,
    })
    if (!source) return { error: 'BOARD_NOT_FOUND' }
    // Column state bindings name a source attached to this project, so they
    // copy across boards unchanged.
    columns = source.columns.map((column, index) => ({
      organizationId: project.organizationId,
      name: column.name,
      category: column.category,
      position: index,
      stateBindings: column.stateBindings as Prisma.InputJsonValue,
    }))
  }
  const position =
    ((
      await prisma.board.aggregate({
        where: { projectId: project.id },
        _max: { position: true },
      })
    )._max.position ?? -1) + 1
  const board = await prisma.board.create({
    data: {
      projectId: project.id,
      organizationId: project.organizationId,
      name: input.name,
      style: input.style ?? 'kanban',
      position,
      createdByUserId: input.createdByUserId ?? null,
      columns: { create: columns },
    },
    include: boardInclude,
  })
  return mapBoard(board)
}

export const updateBoard = async (
  prisma: PrismaClient,
  projectId: string,
  boardId: string,
  input: {
    name?: string
    style?: BoardStyle
    filter?: BoardFilter
    position?: number
    isDefault?: true
  },
): Promise<BoardRecord | BoardMutationError> => {
  const existing = await prisma.board.findFirst({
    where: { id: boardId, projectId },
    select: { id: true },
  })
  if (!existing) return { error: 'BOARD_NOT_FOUND' }

  const board = await prisma.$transaction(async (tx) => {
    // One default per project is a partial unique index, so the demotion has
    // to happen before the promotion rather than beside it.
    if (input.isDefault) {
      await tx.board.updateMany({
        where: { projectId, isDefault: true, NOT: { id: boardId } },
        data: { isDefault: false },
      })
    }
    return tx.board.update({
      where: { id: boardId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        ...(input.filter !== undefined
          ? { filter: input.filter as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.isDefault ? { isDefault: true } : {}),
      },
      include: boardInclude,
    })
  })
  return mapBoard(board)
}

/**
 * Delete a board. Refuses the last one — a project always has somewhere to
 * show its work — and requires the caller to name the replacement when the
 * board being deleted is the default, so the project is never left without one.
 */
export const deleteBoard = async (
  prisma: PrismaClient,
  projectId: string,
  boardId: string,
  newDefaultBoardId?: string,
): Promise<{ ok: true } | BoardMutationError> => {
  const board = await prisma.board.findFirst({
    where: { id: boardId, projectId },
    select: { id: true, isDefault: true },
  })
  if (!board) return { error: 'BOARD_NOT_FOUND' }
  if ((await prisma.board.count({ where: { projectId } })) <= 1) {
    return { error: 'BOARD_LAST' }
  }
  if (board.isDefault) {
    if (!newDefaultBoardId || newDefaultBoardId === boardId) {
      return { error: 'BOARD_DEFAULT_REPLACEMENT_REQUIRED' }
    }
    const replacement = await prisma.board.count({
      where: { id: newDefaultBoardId, projectId },
    })
    if (replacement === 0) return { error: 'BOARD_DEFAULT_REPLACEMENT_REQUIRED' }
  }
  await prisma.$transaction(async (tx) => {
    await tx.board.delete({ where: { id: boardId } })
    if (board.isDefault && newDefaultBoardId) {
      await tx.board.update({
        where: { id: newDefaultBoardId },
        data: { isDefault: true },
      })
    }
  })
  return { ok: true }
}

// ─── Column writes ────────────────────────────────────────────────────────

export const createBoardColumn = async (
  prisma: PrismaClient,
  board: { id: string; organizationId: string },
  input: {
    name: string
    category: ColumnCategory
    position?: number
    stateBindings?: BoardColumnStateBinding[]
  },
): Promise<BoardColumnRecord> => {
  const position =
    input.position ??
    ((
      await prisma.boardColumn.aggregate({
        where: { boardId: board.id },
        _max: { position: true },
      })
    )._max.position ?? -1) + 1
  const column = await prisma.boardColumn.create({
    data: {
      boardId: board.id,
      organizationId: board.organizationId,
      name: input.name,
      category: input.category,
      position,
      stateBindings: (input.stateBindings ?? []) as unknown as Prisma.InputJsonValue,
    },
  })
  return mapBoardColumn(column)
}

export const updateBoardColumn = async (
  prisma: PrismaClient,
  boardId: string,
  columnId: string,
  input: {
    name?: string
    category?: ColumnCategory
    position?: number
    stateBindings?: BoardColumnStateBinding[]
  },
): Promise<BoardColumnRecord | BoardMutationError> => {
  const existing = await prisma.boardColumn.findFirst({
    where: { id: columnId, boardId },
    select: { id: true, category: true },
  })
  if (!existing) return { error: 'COLUMN_NOT_FOUND' }
  const column = await prisma.$transaction(async (tx) => {
    const updated = await tx.boardColumn.update({
      where: { id: columnId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.stateBindings !== undefined
          ? { stateBindings: input.stateBindings as unknown as Prisma.InputJsonValue }
          : {}),
      },
    })
    // A column that changed category can no longer hold the placements it has:
    // every one of them was written for work in the old category, and
    // `resolveBoardPlacement` would ignore them anyway. Dropping them here
    // keeps board-written data from going stale.
    if (input.category !== undefined && input.category !== existing.category) {
      await tx.taskBoardPlacement.deleteMany({ where: { columnId } })
    }
    return updated
  })
  return mapBoardColumn(column)
}

export const deleteBoardColumn = async (
  prisma: PrismaClient,
  boardId: string,
  columnId: string,
): Promise<{ ok: true } | BoardMutationError> => {
  const result = await prisma.boardColumn.deleteMany({ where: { id: columnId, boardId } })
  if (result.count === 0) return { error: 'COLUMN_NOT_FOUND' }
  return { ok: true }
}

export const isBoardMutationError = isError
