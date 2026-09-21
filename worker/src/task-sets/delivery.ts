import { Prisma, type PrismaClient, type TaskSet } from '@prisma/client'
import {
  AuthorizedActionContextSchema, TaskSetReceiverSchema, type AuthorizedActionContext, type TaskSetDisclosure,
} from '@nessie/schemas'
import { assertTaskSetDisclosure, lockTaskSet, validateTaskSetReceiver } from '@nessie/team-admin'
import { computeReplyBasis } from '../run/execute/disclosure-basis.js'
import { TaskSetBlocked, TaskSetWait } from './state.js'

/** A binding is not permission to export a narrower audience into that room. */
export const assertTaskSetDeliveryDestination = async (
  prisma: PrismaClient, set: TaskSet, actor: AuthorizedActionContext, disclosure: TaskSetDisclosure,
) => {
  const receiver = TaskSetReceiverSchema.parse(set.receiver)
  await assertTaskSetDisclosure(prisma, actor, disclosure)
  await validateTaskSetReceiver(prisma, actor, receiver)
  const channel = await prisma.channel.findFirstOrThrow({
    where: { id: receiver.channelId, organizationId: set.organizationId, deletedAt: null, archivedAt: null },
    select: {
      id: true, organizationId: true, projectId: true, teamId: true, visibility: true,
      members: { select: { userId: true } }, agentBindings: { select: { agentId: true } },
    },
  })
  const ownerOnly = channel.visibility === 'private' && channel.members.length > 0
    && channel.members.every((member) => member.userId === set.ownerUserId)
  const basis = ownerOnly ? disclosure.basisScopes.filter((scope) =>
    scope.scopeType !== 'user' || scope.scopeId !== set.ownerUserId) : disclosure.basisScopes
  if (computeReplyBasis(basis, {
    organizationId: channel.organizationId, projectId: channel.projectId, teamId: channel.teamId, channelId: channel.id,
  }, channel.agentBindings.map((binding) => binding.agentId)).length) {
    throw new TaskSetBlocked('receiver_source_access_required')
  }
  return receiver
}

export const queueTaskSetDelivery = async (
  prisma: PrismaClient, set: TaskSet, disclosure: TaskSetDisclosure,
  options: { retryFailed: boolean; outputPageId: string | null; leaseToken: string },
): Promise<'pending' | 'delivered' | 'blocked'> => {
  const actor = AuthorizedActionContextSchema.parse(set.launchOrigin)
  const receiver = await assertTaskSetDeliveryDestination(prisma, set, actor, disclosure)
  return prisma.$transaction(async (tx) => {
    await lockTaskSet(tx, set.id)
    const current = await tx.taskSet.findUniqueOrThrow({ where: { id: set.id } })
    const state = current.outputState as { lease?: { token?: string } } | null
    if (state?.lease?.token !== options.leaseToken) throw new TaskSetWait('output_claim_lost')
    if (!['running', 'waiting', 'completed'].includes(current.status)) throw new TaskSetWait('paused')
    if (JSON.stringify(current.receiver) !== JSON.stringify(set.receiver)) {
      throw new TaskSetBlocked('receiver_configuration_changed')
    }
    const correlationId = `task-set:${set.id}`
    const existing = await tx.agentMailboxMessage.findUnique({
      where: { toAgentId_correlationId: { toAgentId: receiver.agentId, correlationId } },
    })
    if (existing) {
      if (existing.taskSetId !== set.id || existing.channelId !== receiver.channelId
        || existing.actorId !== set.ownerUserId || existing.actorType !== 'user') {
        throw new TaskSetBlocked('receiver_delivery_conflict')
      }
      if (existing.status === 'delivered') return 'delivered'
      if (existing.status === 'dead_letter') {
        if (!options.retryFailed) return 'blocked'
        await tx.agentMailboxMessage.update({ where: { id: existing.id }, data: {
          status: 'queued', attempts: 0, claimedAt: null, visibleAt: new Date(),
        } })
      }
      return 'pending'
    }
    await tx.agentMailboxMessage.create({ data: {
      organizationId: set.organizationId, taskSetId: set.id, actorId: set.ownerUserId, actorType: 'user',
      fromAgentId: set.executionAgentId, toAgentId: receiver.agentId, channelId: receiver.channelId,
      correlationId, subject: `Task set complete: ${set.name}`,
      body: [
        `Task set ${set.id} has finished processing.`,
        `Completed items: ${set.completedItems}; explicitly skipped: ${set.skippedItems}.`,
        options.outputPageId ? `Documents output page ID: ${options.outputPageId}.` : 'The durable results are in the task set journal.',
        'Read results using the task-set tools with bounded pagination. No task-set items need to be rerun.',
        `Receiver instructions:\n${receiver.instructions}`,
      ].join('\n\n'),
      basis: disclosure.basisScopes as Prisma.InputJsonValue,
      disclosureSources: disclosure.disclosureSources as Prisma.InputJsonValue,
      ...(actor.actionContext.uoaIdentity ? { uoaIdentity: actor.actionContext.uoaIdentity } : {}),
    } })
    return 'pending'
  })
}
