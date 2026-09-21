import type { Prisma, PrismaClient, TaskSet } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'
import {
  resolveDisclosureViewer, resolveLiveEntitlementDecision, viewerSatisfiesBasis,
} from '@nessie/runtime'
import { TaskSetDisclosureSchema, type AuthorizedActionContext } from '@nessie/schemas'

export class TaskSetError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message)
    this.name = 'TaskSetError'
  }
}

export const taskSetUserId = (actor: AuthorizedActionContext): string => {
  const id = actor.actionContext.effectiveUserId
    ?? (actor.actor.actorType === 'user' ? actor.actor.actorId : null)
  if (!id) throw new TaskSetError('TASK_SET_USER_REQUIRED', 'A task set needs a responsible person.', 403)
  return id
}

export const assertTaskSetActor = async (prisma: PrismaClient, actor: AuthorizedActionContext) => {
  const userId = taskSetUserId(actor)
  const decision = await resolveLiveEntitlementDecision(prisma, {
    organizationId: actor.tenant.organizationId, userId,
    allowStoredIdentity: true, uoaIdentity: actor.actionContext.uoaIdentity,
  })
  if (decision.status !== 'allowed') {
    throw new TaskSetError('TASK_SET_AUTHORIZATION', 'Task-set access needs reauthorization.', 403)
  }
  return { userId, decision }
}

export const assertTaskSetDisclosure = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, value: unknown,
): Promise<void> => {
  const { userId, decision } = await assertTaskSetActor(prisma, actor)
  const disclosure = TaskSetDisclosureSchema.parse(value)
  const viewer = await resolveDisclosureViewer(prisma, actor.tenant.organizationId, userId, {
    allowStoredUoaIdentity: true, liveEntitlements: decision.entitlements,
  })
  if (!viewerSatisfiesBasis(disclosure.basisScopes, viewer)
    || disclosure.disclosureSources.some((source) => source.sourceAuthorUserId === null)) {
    throw new TaskSetError('TASK_SET_SOURCE_ACCESS', 'You can no longer read a source of this task set.', 403)
  }
}

export const getTaskSetForActor = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, id: string,
): Promise<TaskSet> => {
  const { userId } = await assertTaskSetActor(prisma, actor)
  const set = await prisma.taskSet.findFirst({
    where: { id, organizationId: actor.tenant.organizationId, ownerUserId: userId },
  })
  if (!set) throw new TaskSetError('TASK_SET_NOT_FOUND', 'Task set not found.', 404)
  await assertTaskSetDisclosure(prisma, actor, set.disclosure)
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
