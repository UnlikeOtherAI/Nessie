import { Prisma } from '@prisma/client'
import {
  TaskSetCreateSchema, TaskSetUpdateSchema, TaskSetProcessorSchema,
  type AuthorizedActionContext, type TaskSetCreate, type TaskSetUpdate,
} from '@nessie/schemas'
import { personalAssistantDmKey } from './approval-card.js'
import { appendTaskSetItems, lockTaskSet } from './task-set-items.js'
import { resolveTaskSetProcessor, type TaskSetModelDeps } from './task-set-processors.js'
import {
  assertTaskSetActor, auditTaskSetMutation, getTaskSetForActor, taskSetJson, TaskSetError,
} from './task-set-access.js'
import { taskSetRecord } from './task-set-read.js'

export const validateTaskSetReceiver = async (
  prisma: TaskSetModelDeps['prisma'], actor: AuthorizedActionContext, receiver: TaskSetCreate['receiver'],
): Promise<void> => {
  if (!receiver) return
  const { userId } = await assertTaskSetActor(prisma, actor)
  const binding = await prisma.agentBinding.findFirst({ where: {
    agentId: receiver.agentId, channelId: receiver.channelId,
    agent: { organizationId: actor.tenant.organizationId, deletedAt: null },
    channel: { organizationId: actor.tenant.organizationId, deletedAt: null, members: { some: { userId } } },
  }, select: { id: true } })
  if (!binding) throw new TaskSetError('TASK_SET_RECEIVER', 'Select an agent in a conversation you can access.', 403)
}

export const createTaskSetForActor = async (
  deps: TaskSetModelDeps, actor: AuthorizedActionContext, raw: TaskSetCreate,
  disclosure?: unknown,
) => {
  const input = TaskSetCreateSchema.parse(raw)
  const { userId } = await assertTaskSetActor(deps.prisma, actor)
  const processor = await resolveTaskSetProcessor(deps, actor, input.processor)
  await validateTaskSetReceiver(deps.prisma, actor, input.receiver)
  if (input.source && input.items?.length) throw new TaskSetError('TASK_SET_SOURCE', 'Choose a source or manual tasks.')
  const channel = await deps.prisma.channel.findFirst({ where: {
    organizationId: actor.tenant.organizationId, deletedAt: null,
    dmKey: personalAssistantDmKey({ organizationId: actor.tenant.organizationId, userId }),
    members: { some: { userId } },
  }, select: { id: true } })
  if (!channel) throw new TaskSetError('TASK_SET_SETUP', 'Open your personal assistant once to finish setup.')
  if (input.originThreadId) {
    const origin = await deps.prisma.thread.findFirst({ where: { id: input.originThreadId,
      channel: { organizationId: actor.tenant.organizationId, members: { some: { userId } } } }, select: { id: true } })
    if (!origin) throw new TaskSetError('TASK_SET_ORIGIN', 'Origin conversation not found.', 404)
  }
  const basis = disclosure ?? {
    classified: true, basisScopes: [{ scopeType: 'user', scopeId: userId }], disclosureSources: [],
  }
  return deps.prisma.$transaction(async (tx) => {
    const thread = await tx.thread.create({ data: { channelId: channel.id, title: input.name } })
    const set = await tx.taskSet.create({ data: {
      name: input.name, objective: input.objective, instructions: input.instructions,
      organizationId: actor.tenant.organizationId, ownerUserId: userId,
      executionAgentId: processor.agentId, capacityKey: processor.capacityKey, executionThreadId: thread.id,
      processor: taskSetJson(input.processor), source: input.source ? taskSetJson(input.source) : Prisma.DbNull,
      sourceVersionId: input.source?.versionId,
      output: taskSetJson(input.output), receiver: input.receiver ? taskSetJson(input.receiver) : Prisma.DbNull,
      disclosure: taskSetJson(basis),
      launchOrigin: taskSetJson({
        actor: { actorType: 'user', actorId: userId }, tenant: actor.tenant,
        actionContext: { requestId: actor.actionContext.requestId, effectiveUserId: userId,
          ...(actor.actionContext.uoaIdentity ? { uoaIdentity: actor.actionContext.uoaIdentity } : {}) },
      }),
      maxParallelRequests: input.maxParallelRequests ?? 1, maxAttempts: input.maxAttempts ?? 3,
      search: input.search ?? 'none', originThreadId: input.originThreadId,
      originMessageId: input.originMessageId, deliveryStatus: input.receiver ? 'pending' : 'none',
    } })
    if (input.items?.length) await appendTaskSetItems(tx, set.id, input.items, basis)
    await auditTaskSetMutation(tx, actor, set.id, 'created')
    return taskSetRecord(await tx.taskSet.findUniqueOrThrow({ where: { id: set.id } }))
  })
}

export const updateTaskSetForActor = async (
  deps: TaskSetModelDeps, actor: AuthorizedActionContext, id: string, raw: TaskSetUpdate,
) => {
  const previous = await getTaskSetForActor(deps.prisma, actor, id)
  const patch = TaskSetUpdateSchema.parse(raw)
  const processor = patch.processor
    ? await resolveTaskSetProcessor(deps, actor, patch.processor)
    : null
  await validateTaskSetReceiver(deps.prisma, actor, patch.receiver)
  return deps.prisma.$transaction(async (tx) => {
    await lockTaskSet(tx, id)
    const set = await tx.taskSet.findUniqueOrThrow({ where: { id } })
    if (!['draft', 'paused', 'blocked'].includes(set.status) || set.currentItemId) {
      throw new TaskSetError('TASK_SET_BUSY', 'Wait for the active item to stop before editing the set.')
    }
    if (patch.source !== undefined && (set.totalItems > 0 || set.inputClosedAt)) {
      throw new TaskSetError('TASK_SET_SOURCE_FROZEN', 'The input revision is frozen; create another task set.')
    }
    const updated = await tx.taskSet.update({ where: { id }, data: {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.objective === undefined ? {} : { objective: patch.objective }),
      ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
      ...(processor ? { executionAgentId: processor.agentId, capacityKey: processor.capacityKey,
        processor: taskSetJson(patch.processor ?? TaskSetProcessorSchema.parse(previous.processor)) } : {}),
      ...(patch.source === undefined ? {} : { source: patch.source ? taskSetJson(patch.source) : Prisma.DbNull,
        sourceVersionId: patch.source?.versionId ?? null }),
      ...(patch.output ? { output: taskSetJson(patch.output) } : {}),
      ...(patch.receiver === undefined ? {} : { receiver: patch.receiver ? taskSetJson(patch.receiver) : Prisma.DbNull,
        deliveryStatus: patch.receiver ? 'pending' : 'none' }),
      ...(patch.maxAttempts === undefined ? {} : { maxAttempts: patch.maxAttempts }),
      ...(patch.maxParallelRequests === undefined ? {} : { maxParallelRequests: patch.maxParallelRequests }),
      ...(patch.search === undefined ? {} : { search: patch.search }),
      revision: { increment: 1 },
    } })
    await auditTaskSetMutation(tx, actor, id, 'updated')
    return taskSetRecord(updated)
  })
}
