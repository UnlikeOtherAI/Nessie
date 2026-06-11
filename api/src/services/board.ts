import type { ColumnCategory, PrismaClient } from '@prisma/client'
import { parseProjectId } from '@nessie/schemas'
import type { BoardColumnRecord, ProjectBoardRecord } from '../contracts.js'

// The columns every project starts with — also seeded for existing projects in
// the add_board_columns migration and at bootstrap.
export const DEFAULT_COLUMNS: { name: string; category: ColumnCategory }[] = [
  { name: 'To do', category: 'todo' },
  { name: 'In progress', category: 'in_progress' },
  { name: 'Review', category: 'review' },
  { name: 'Done', category: 'done' },
]

// Nested-create rows for a project's default columns (projectId is supplied by
// the parent project create, so it is omitted here).
export const defaultColumnCreateData = (organizationId: string) =>
  DEFAULT_COLUMNS.map((column, index) => ({
    organizationId,
    name: column.name,
    category: column.category,
    position: index,
  }))

const mapColumn = (column: {
  id: string
  projectId: string
  name: string
  category: ColumnCategory
  position: number
}): BoardColumnRecord => ({
  id: column.id,
  projectId: parseProjectId(column.projectId),
  name: column.name,
  category: column.category,
  position: column.position,
})

// Returns the project's board config, lazily seeding the default columns if a
// project somehow has none (e.g. created before this feature on a fresh DB).
export const getProjectBoard = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string; boardStyle: 'kanban' | 'scrum' },
): Promise<ProjectBoardRecord> => {
  let columns = await prisma.boardColumn.findMany({
    where: { projectId: project.id },
    orderBy: { position: 'asc' },
  })
  if (columns.length === 0) {
    await prisma.boardColumn.createMany({
      data: defaultColumnCreateData(project.organizationId).map((column) => ({
        ...column,
        projectId: project.id,
      })),
    })
    columns = await prisma.boardColumn.findMany({
      where: { projectId: project.id },
      orderBy: { position: 'asc' },
    })
  }
  return { style: project.boardStyle, columns: columns.map(mapColumn) }
}

export const createColumn = async (
  prisma: PrismaClient,
  project: { id: string; organizationId: string },
  input: { name: string; category: ColumnCategory; position?: number },
): Promise<BoardColumnRecord> => {
  const position =
    input.position ??
    ((await prisma.boardColumn.aggregate({
      where: { projectId: project.id },
      _max: { position: true },
    }))._max.position ?? -1) + 1
  const column = await prisma.boardColumn.create({
    data: {
      projectId: project.id,
      organizationId: project.organizationId,
      name: input.name,
      category: input.category,
      position,
    },
  })
  return mapColumn(column)
}

export const updateColumn = async (
  prisma: PrismaClient,
  projectId: string,
  columnId: string,
  input: { name?: string; category?: ColumnCategory; position?: number },
): Promise<BoardColumnRecord | null> => {
  const existing = await prisma.boardColumn.findFirst({
    where: { id: columnId, projectId },
    select: { id: true },
  })
  if (!existing) return null
  const column = await prisma.boardColumn.update({
    where: { id: columnId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
    },
  })
  return mapColumn(column)
}

export const deleteColumn = async (
  prisma: PrismaClient,
  projectId: string,
  columnId: string,
): Promise<boolean> => {
  const result = await prisma.boardColumn.deleteMany({ where: { id: columnId, projectId } })
  return result.count > 0
}

export const setBoardStyle = async (
  prisma: PrismaClient,
  projectId: string,
  style: 'kanban' | 'scrum',
): Promise<void> => {
  await prisma.project.update({ where: { id: projectId }, data: { boardStyle: style } })
}
