import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { lockTaskSet, taskSetJson } from '@nessie/team-admin'
import { reserveLocalInferenceResource } from '@nessie/runtime'
import { TaskSetProcessorSchema } from '@nessie/schemas'
import { lockTaskSetCapacity, TaskSetBlocked, TaskSetWait } from './state.js'

export const claimTaskSetItem = async (prisma: PrismaClient, id: string) => prisma.$transaction(async (tx) => {
  await lockTaskSet(tx, id)
  const set = await tx.taskSet.findUniqueOrThrow({ where: { id } })
  if (set.currentItemId) {
    const item = await tx.taskSetItem.findUniqueOrThrow({ where: { id: set.currentItemId } })
    const attempt = item.currentAttemptId
      ? await tx.taskSetAttempt.findUniqueOrThrow({ where: { id: item.currentAttemptId } }) : null
    if (!attempt) throw new TaskSetBlocked('attempt_missing')
    return { set, item, attempt }
  }
  if (!['running', 'waiting'].includes(set.status)) return null
  const item = await tx.taskSetItem.findFirst({ where: { taskSetId: id, sequence: set.nextSequence } })
  if (!item) return null
  if (item.status === 'completed' || item.status === 'skipped') throw new TaskSetBlocked('cursor_conflict')
  const failures = await tx.taskSetAttempt.count({ where: {
    itemId: item.id, number: { gt: item.retryBase }, status: 'failed',
  } })
  if (failures >= set.maxAttempts) throw new TaskSetBlocked('retry_limit_reached')
  const dependencies = await tx.taskSetItem.findMany({ where: { taskSetId: id, id: { in: item.dependencies } } })
  if (dependencies.length !== item.dependencies.length
    || dependencies.some((dependency) => dependency.sequence >= item.sequence || dependency.status !== 'completed' || dependency.result === null)) {
    await tx.taskSetItem.update({ where: { id: item.id }, data: { status: 'blocked_dependency', statusChangedAt: new Date() } })
    // This transaction commits the visible item state; the outer driver records the set health.
    return { blocked: 'blocked_dependency' as const }
  }
  const processor = TaskSetProcessorSchema.parse(set.processor)
  await lockTaskSetCapacity(tx, set.capacityKey)
  const limits = await tx.taskSet.aggregate({
    where: { capacityKey: set.capacityKey, status: { in: ['running', 'waiting'] } }, _min: { maxParallelRequests: true },
  })
  const active = await tx.taskSetItem.count({ where: { status: 'running', taskSet: { capacityKey: set.capacityKey } } })
  if (active >= (limits._min.maxParallelRequests ?? 1)) throw new TaskSetWait('waiting_for_capacity')
  const runId = randomUUID()
  let admissionId: string | null = null
  if (processor.localInferenceBindingId) {
    const binding = await tx.agentLocalInferenceBinding.findUnique({ where: { id: processor.localInferenceBindingId } })
    const host = binding ? await tx.localInferenceHost.findUnique({ where: { id: binding.hostId } }) : null
    if (!binding || binding.status !== 'active' || !host || host.revokedAt) throw new TaskSetBlocked('processor_authorization_changed')
    if (host.pausedAt) throw new TaskSetWait('processor_paused')
    if (!host.lastSeenAt || host.lastSeenAt.getTime() < Date.now() - 60_000) throw new TaskSetWait('processor_offline', true)
    if (!host.inferenceResourceId) throw new TaskSetBlocked('processor_resource_setup_required')
    const admission = await reserveLocalInferenceResource(tx, {
      resourceId: host.inferenceResourceId, reservationKey: `task-set:${id}:${item.id}:${item.attempts + 1}`, runId,
    })
    if (admission.kind === 'waiting') {
      if (admission.reason === 'termination_uncertain') throw new TaskSetBlocked(admission.reason)
      throw new TaskSetWait(admission.reason)
    }
    admissionId = admission.admission.admissionId
  }
  await tx.run.create({ data: {
    id: runId, agentId: set.executionAgentId, threadId: set.executionThreadId,
    inferenceResourceAdmissionId: admissionId,
  } })
  const task = await tx.task.create({ data: {
    agentId: set.executionAgentId, organizationId: set.organizationId,
    runId, purpose: `Task set item ${item.sequence}`, status: 'inbox',
  } })
  const attempt = await tx.taskSetAttempt.create({ data: {
    itemId: item.id, number: item.attempts + 1, runId, taskId: task.id,
    inputSnapshot: taskSetJson({
      itemRevision: item.revision, setRevision: set.revision, input: item.input, prompt: item.prompt,
      objective: set.objective, instructions: set.instructions, processor: set.processor,
      dependencies: item.dependencies, disclosure: item.disclosure,
    }),
  } })
  const updatedItem = await tx.taskSetItem.update({ where: { id: item.id }, data: {
    attempts: { increment: 1 }, currentAttemptId: attempt.id, reason: null,
    status: 'running', statusChangedAt: new Date(),
  } })
  const updatedSet = await tx.taskSet.update({ where: { id }, data: {
    currentItemId: item.id, status: 'running', reason: null, offlineSince: null,
    nextAttemptAt: new Date(Date.now() + 60_000),
  } })
  await tx.runBasisScope.createMany({ data: [{
    runId, organizationId: set.organizationId, scopeType: 'user', scopeId: set.ownerUserId,
  }], skipDuplicates: true })
  return { set: updatedSet, item: updatedItem, attempt }
})
