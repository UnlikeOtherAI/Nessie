import type { PrismaClient } from '@prisma/client'
import { resolveDisclosureViewer, resolveLiveEntitlementDecision, viewerSatisfiesBasis } from '@nessie/runtime'
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

