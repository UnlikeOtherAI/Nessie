import { Prisma, type PrismaClient, type TaskSet, type TaskSetItem } from '@prisma/client'
import {
  buildPage, decodeKeysetCursor, resolvePageLimit,
  TaskSetRecordSchema, TaskSetItemRecordSchema, TaskSetDisclosureSchema,
  type AuthorizedActionContext, type PaginationDirection,
} from '@nessie/schemas'
import type { TaskSetReadObserver } from './task-set-disclosure.js'
import {
  assertTaskSetActor, assertTaskSetDisclosure, assertTaskSetContentAccess, getTaskSetForActor, TaskSetError,
} from './task-set-access.js'

export const taskSetRecord = (row: TaskSet) => TaskSetRecordSchema.parse({
  ...row, createdAt: row.createdAt.toISOString(), statusChangedAt: row.statusChangedAt.toISOString(),
})
export const taskSetItemRecord = (row: TaskSetItem) => TaskSetItemRecordSchema.parse({
  ...row, createdAt: row.createdAt.toISOString(), statusChangedAt: row.statusChangedAt.toISOString(),
})

type ListOptions = { cursor?: string; direction?: PaginationDirection; limit?: number; status?: string }
export const listTaskSetsForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, options: ListOptions = {}, onRead?: TaskSetReadObserver,
) => {
  const { userId } = await assertTaskSetActor(prisma, actor)
  const cursor = decodeKeysetCursor(options.cursor)
  const backward = options.direction === 'backward'
  const compare = backward ? 'gt' : 'lt'
  const where: Prisma.TaskSetWhereInput = {
    organizationId: actor.tenant.organizationId, ownerUserId: userId,
    ...(options.status ? { status: options.status } : {}),
    ...(cursor ? { OR: [
      { createdAt: { [compare]: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { [compare]: cursor.id } },
    ] } : {}),
  }
  const rows = await prisma.taskSet.findMany({
    where, orderBy: [{ createdAt: backward ? 'asc' : 'desc' }, { id: backward ? 'asc' : 'desc' }],
    take: resolvePageLimit(options.limit) + 1,
  })
  const page = buildPage({
    rows, hasCursor: Boolean(cursor), direction: options.direction, limit: resolvePageLimit(options.limit),
  })
  const visible = []
  for (const row of page.data) {
    try {
      await assertTaskSetContentAccess(prisma, actor, row)
    } catch {
      // No title, input or result metadata for a revoked source.
      continue
    }
    onRead?.(TaskSetDisclosureSchema.parse(row.disclosure))
    visible.push(taskSetRecord(row))
  }
  return { data: visible, meta: page.meta }
}

export const listTaskSetItemsForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, id: string,
  options: ListOptions = {}, onRead?: TaskSetReadObserver,
) => {
  const set = await getTaskSetForActor(prisma, actor, id, onRead)
  const limit = resolvePageLimit(options.limit)
  const cursor = options.cursor ? Number(options.cursor) : null
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
    throw new Error('Invalid task item cursor')
  }
  const backward = options.direction === 'backward'
  const rows = await prisma.taskSetItem.findMany({
    where: { taskSetId: set.id, ...(options.status ? { status: options.status } : {}),
      ...(cursor === null ? {} : { sequence: { [backward ? 'lt' : 'gt']: cursor } }) },
    orderBy: { sequence: backward ? 'desc' : 'asc' }, take: limit + 1,
  })
  const more = rows.length > limit
  const page = rows.slice(0, limit)
  if (backward) page.reverse()
  const data = []
  for (const item of page) {
    await assertTaskSetDisclosure(prisma, actor, item.disclosure)
    if (item.resultDisclosure) await assertTaskSetDisclosure(prisma, actor, item.resultDisclosure)
    onRead?.(TaskSetDisclosureSchema.parse(item.disclosure))
    if (item.resultDisclosure) onRead?.(TaskSetDisclosureSchema.parse(item.resultDisclosure))
    data.push(taskSetItemRecord(item))
  }
  return { data, meta: {
    hasMore: backward ? cursor !== null : more,
    nextCursor: (backward ? cursor !== null : more) && page.length ? String(page.at(-1)!.sequence) : null,
    prevCursor: (backward ? more : cursor !== null) && page.length ? String(page[0]!.sequence) : null,
    total: set.totalItems,
  } }
}

export const getTaskSetItemForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, id: string, itemId: string, onRead?: TaskSetReadObserver,
) => {
  await getTaskSetForActor(prisma, actor, id, onRead)
  const item = await prisma.taskSetItem.findFirst({ where: { id: itemId, taskSetId: id } })
  if (!item) throw new TaskSetError('TASK_SET_ITEM_NOT_FOUND', 'Task item not found.', 404)
  await assertTaskSetDisclosure(prisma, actor, item.disclosure)
  if (item.resultDisclosure) await assertTaskSetDisclosure(prisma, actor, item.resultDisclosure)
  onRead?.(TaskSetDisclosureSchema.parse(item.disclosure))
  if (item.resultDisclosure) onRead?.(TaskSetDisclosureSchema.parse(item.resultDisclosure))
  return taskSetItemRecord(item)
}
