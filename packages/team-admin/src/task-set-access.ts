import type { TaskSetReadObserver } from './task-set-disclosure.js'
import type { Prisma, PrismaClient, TaskSet } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import { TaskSetDisclosureSchema, TaskSetSourceSchema, type AuthorizedActionContext } from '@nessie/schemas'
import { assertTaskSetActor, assertTaskSetDisclosure, TaskSetError } from './task-set-authority.js'
import { authorizeTaskSetSource } from './task-set-documents.js'

export * from './task-set-authority.js'

/** A native tool's executing agent is stamped by buildToolActorContext, not model arguments. */
export const assertTaskSetContentAccess = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, set: Pick<TaskSet, 'disclosure' | 'source'>,
): Promise<void> => {
  await assertTaskSetDisclosure(prisma, actor, set.disclosure)
  if (!set.source) return
  const processingAgentId = actor.actionContext.agentId
    ?? (actor.actor.actorType === 'agent' ? actor.actor.actorId : undefined)
  try {
    await authorizeTaskSetSource(prisma, actor, TaskSetSourceSchema.parse(set.source), { processingAgentId })
  } catch {
    throw new TaskSetError('TASK_SET_SOURCE_ACCESS', 'You or this agent can no longer read the source document.', 403)
  }
}

export const getTaskSetForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, id: string, onRead?: TaskSetReadObserver,
): Promise<TaskSet> => {
  const { userId } = await assertTaskSetActor(prisma, actor)
  const set = await prisma.taskSet.findFirst({
    where: { id, organizationId: actor.tenant.organizationId, ownerUserId: userId },
  })
  if (!set) throw new TaskSetError('TASK_SET_NOT_FOUND', 'Task set not found.', 404)
  await assertTaskSetContentAccess(prisma, actor, set)
  onRead?.(TaskSetDisclosureSchema.parse(set.disclosure))
  return set
}

export const auditTaskSetMutation = (
  tx: Prisma.TransactionClient, actor: AuthorizedActionContext, id: string, action: string,
) => writeAuditEntryInTransaction(tx, {
  action: `task_set.${action}`, actorId: actor.actor.actorId, actorType: actor.actor.actorType,
  metadata: actor.actionContext.agentCredentialId
    ? { agentCredentialId: actor.actionContext.agentCredentialId } : {},
  organizationId: actor.tenant.organizationId, outcome: 'success',
  requestId: actor.actionContext.requestId, resourceId: id, resourceType: 'task_set',
})

export const taskSetJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue
