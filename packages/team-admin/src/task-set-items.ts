import { Prisma, type PrismaClient } from '@prisma/client'
import { isDeepStrictEqual } from 'node:util'
import {
  TaskSetItemInputSchema, TaskSetItemUpdateSchema,
  type AuthorizedActionContext, type TaskSetItemInput, type TaskSetItemUpdate,
} from '@nessie/schemas'
import { auditTaskSetMutation, getTaskSetForActor, taskSetJson, TaskSetError } from './task-set-access.js'
import { taskSetItemRecord } from './task-set-read.js'

export const lockTaskSet = async (tx: Prisma.TransactionClient, id: string): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM task_sets WHERE id = ${id}::uuid FOR UPDATE`)
}

export const validateTaskSetDependencies = async (
  tx: Prisma.TransactionClient, taskSetId: string, sequence: number, dependencies: string[],
): Promise<void> => {
  const ids = [...new Set(dependencies)]
  const count = await tx.taskSetItem.count({
    where: { taskSetId, id: { in: ids }, sequence: { lt: sequence } },
  })
  if (count !== ids.length || ids.length !== dependencies.length) {
    throw new TaskSetError('TASK_SET_DEPENDENCIES', 'Dependencies must name distinct earlier items in this set.')
  }
}

export const appendTaskSetItems = async (
  tx: Prisma.TransactionClient, taskSetId: string, inputs: TaskSetItemInput[], disclosure: unknown,
) => {
  await lockTaskSet(tx, taskSetId)
  const set = await tx.taskSet.findUniqueOrThrow({ where: { id: taskSetId } })
  if (set.status !== 'draft' || set.inputClosedAt || set.source) {
    throw new TaskSetError('TASK_SET_CLOSED', 'Add manual tasks while the set is a draft with no source.')
  }
  let sequence = set.totalItems
  const added = []
  for (const raw of inputs) {
    const input = TaskSetItemInputSchema.parse(raw)
    if (JSON.stringify(input.input ?? {}).length > 256_000) {
      throw new TaskSetError('TASK_SET_INPUT_SIZE', 'An item input exceeds 256 KB; select fewer fields.')
    }
    const existing = await tx.taskSetItem.findUnique({
      where: { taskSetId_clientKey: { taskSetId, clientKey: input.clientKey } },
    })
    if (existing) {
      if (existing.prompt !== input.prompt || !isDeepStrictEqual(existing.input, input.input ?? {})
        || !isDeepStrictEqual(existing.dependencies, input.dependencies ?? [])) {
        throw new TaskSetError('TASK_SET_ITEM_CONFLICT', 'This client key already names a different task.')
      }
      added.push(existing)
      continue
    }
    sequence += 1
    await validateTaskSetDependencies(tx, taskSetId, sequence, input.dependencies ?? [])
    added.push(await tx.taskSetItem.create({ data: {
      taskSetId, sequence, clientKey: input.clientKey, prompt: input.prompt,
      input: taskSetJson(input.input), dependencies: input.dependencies ?? [],
      disclosure: taskSetJson(disclosure),
    } }))
  }
  await tx.taskSet.update({ where: { id: taskSetId }, data: { totalItems: sequence } })
  return added
}

export const addTaskSetItemsForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, id: string, items: TaskSetItemInput[],
) => {
  const set = await getTaskSetForActor(prisma, actor, id)
  if (items.length > 500) throw new TaskSetError('TASK_SET_PAGE_SIZE', 'Add at most 500 tasks per call.')
  return prisma.$transaction(async (tx) => {
    const added = await appendTaskSetItems(tx, id, items, set.disclosure)
    await auditTaskSetMutation(tx, actor, id, 'items_added')
    return added.map(taskSetItemRecord)
  })
}

export const updateTaskSetItemForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, id: string, itemId: string, raw: TaskSetItemUpdate,
) => {
  await getTaskSetForActor(prisma, actor, id)
  const input = TaskSetItemUpdateSchema.parse(raw)
  return prisma.$transaction(async (tx) => {
    await lockTaskSet(tx, id)
    const set = await tx.taskSet.findUniqueOrThrow({ where: { id } })
    const item = await tx.taskSetItem.findFirst({ where: { id: itemId, taskSetId: id } })
    if (!item) throw new TaskSetError('TASK_SET_ITEM_NOT_FOUND', 'Task item not found.', 404)
    if (!['draft', 'paused', 'blocked'].includes(set.status) || ['running', 'completed', 'skipped'].includes(item.status)) {
      throw new TaskSetError('TASK_SET_ITEM_BUSY', 'Pause the set to edit an unfinished item.')
    }
    if (input.dependencies) await validateTaskSetDependencies(tx, id, item.sequence, input.dependencies)
    if (Buffer.byteLength(JSON.stringify(input.input ?? {})) > 256_000) {
      throw new TaskSetError('TASK_SET_INPUT_SIZE', 'An item input exceeds 256 KB; select fewer fields.')
    }
    await tx.taskSetItemRevision.create({ data: {
      itemId, revision: item.revision, snapshot: taskSetJson({
        prompt: item.prompt, input: item.input, dependencies: item.dependencies, disclosure: item.disclosure,
      }),
    } })
    const updated = await tx.taskSetItem.update({ where: { id: itemId }, data: {
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(Object.hasOwn(input, 'input') ? { input: taskSetJson(input.input) } : {}),
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      revision: { increment: 1 }, retryBase: item.attempts, reason: null, status: 'pending', statusChangedAt: new Date(),
    } })
    await auditTaskSetMutation(tx, actor, id, 'item_updated')
    return taskSetItemRecord(updated)
  })
}
