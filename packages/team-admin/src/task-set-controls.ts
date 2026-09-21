import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  TaskSetActionSchema, TaskSetProcessorSchema, type AuthorizedActionContext, type TaskSetAction,
} from '@nessie/schemas'
import { auditTaskSetMutation, getTaskSetForActor, TaskSetError } from './task-set-access.js'
import { lockTaskSet } from './task-set-items.js'
import { resolveTaskSetProcessor, type TaskSetModelDeps } from './task-set-processors.js'
import { taskSetRecord } from './task-set-read.js'

export const enqueueTaskSet = async (tx: Prisma.TransactionClient, id: string, revision: number, delayMs = 0) =>
  enqueueQueueJob(tx, {
    topic: 'task_set.execute', payload: { taskSetId: id },
    idempotencyKey: `task-set:${id}:${revision}`, maxAttempts: 10, delayMs,
  })

export const controlTaskSetForActor = async (
  deps: TaskSetModelDeps, actor: AuthorizedActionContext, id: string, raw: TaskSetAction,
) => {
  const action = TaskSetActionSchema.parse(raw)
  const previous = await getTaskSetForActor(deps.prisma, actor, id)
  if (previous.status !== 'completed' && ['start', 'resume', 'retry'].includes(action.action)) {
    await resolveTaskSetProcessor(deps, actor, TaskSetProcessorSchema.parse(previous.processor))
  }
  return deps.prisma.$transaction(async (tx) => {
    await lockTaskSet(tx, id)
    const set = await tx.taskSet.findUniqueOrThrow({ where: { id } })
    const now = new Date()
    if (set.status === 'completed' && action.action === 'retry' && set.deliveryStatus === 'blocked') {
      const updated = await tx.taskSet.update({ where: { id }, data: {
        deliveryStatus: 'pending', reason: null, revision: { increment: 1 }, nextAttemptAt: now,
      } })
      await enqueueTaskSet(tx, id, updated.revision)
      await auditTaskSetMutation(tx, actor, id, 'delivery_retried')
      return taskSetRecord(updated)
    }
    if (['completed', 'cancelled'].includes(set.status)) {
      throw new TaskSetError('TASK_SET_FINISHED', 'This set is finished. Create a new set to process it again.')
    }
    let status = set.status
    if (action.action === 'pause' || action.action === 'cancel') {
      status = action.action === 'pause' ? 'paused' : 'cancelled'
      if (set.currentItemId) {
        const item = await tx.taskSetItem.findUnique({ where: { id: set.currentItemId } })
        const attempt = item?.currentAttemptId
          ? await tx.taskSetAttempt.findUnique({ where: { id: item.currentAttemptId } }) : null
        if (attempt) await tx.run.updateMany({
          where: { id: attempt.runId, status: { in: ['pending', 'running'] } },
          data: { cancelRequestedAt: now, cancelRequestedByUserId: set.ownerUserId },
        })
      }
    } else if (action.action === 'skip') {
      if (set.currentItemId) throw new TaskSetError('TASK_SET_BUSY', 'Wait for the active processor to stop.')
      const item = await tx.taskSetItem.findFirst({ where: {
        taskSetId: id, sequence: set.nextSequence, ...(action.itemId ? { id: action.itemId } : {}),
      } })
      if (!item || item.status === 'completed') throw new TaskSetError('TASK_SET_SKIP', 'Only the next unfinished item can be skipped.')
      await tx.taskSetItem.update({ where: { id: item.id }, data: {
        status: 'skipped', reason: 'Skipped explicitly', statusChangedAt: now,
      } })
      await tx.taskSet.update({ where: { id }, data: { nextSequence: { increment: 1 }, skippedItems: { increment: 1 } } })
      status = 'paused'
    } else {
      if (set.currentItemId) throw new TaskSetError('TASK_SET_BUSY', 'Wait for the active processor to stop.')
      if (action.action === 'start' && !['draft', 'ready'].includes(set.status)) {
        throw new TaskSetError('TASK_SET_ALREADY_STARTED', 'Use Resume to continue this set.')
      }
      if (action.action !== 'start' && !['paused', 'blocked', 'waiting'].includes(set.status)) {
        throw new TaskSetError('TASK_SET_NOT_PAUSED', 'This set is already processing.')
      }
      if (!set.source && set.totalItems === 0) throw new TaskSetError('TASK_SET_EMPTY', 'Add tasks before starting.')
      if (action.action === 'retry') {
        const item = await tx.taskSetItem.findFirst({ where: { taskSetId: id, sequence: set.nextSequence } })
        if (action.itemId && item?.id !== action.itemId) {
          throw new TaskSetError('TASK_SET_RETRY', 'Only the next unfinished item can be retried.')
        }
        if (item) await tx.taskSetItem.update({ where: { id: item.id }, data: {
          status: 'pending', retryBase: item.attempts, reason: null, statusChangedAt: now,
        } })
      }
      status = set.source && !set.inputClosedAt ? 'importing' : 'running'
    }
    const updated = await tx.taskSet.update({ where: { id }, data: {
      status, statusChangedAt: now, reason: null, offlineSince: null,
      revision: { increment: 1 }, nextAttemptAt: now,
      ...(status === 'running' && !set.inputClosedAt ? { inputClosedAt: now } : {}),
    } })
    if (['running', 'importing'].includes(status)) await enqueueTaskSet(tx, id, updated.revision)
    await auditTaskSetMutation(tx, actor, id, action.action)
    return taskSetRecord(updated)
  })
}
