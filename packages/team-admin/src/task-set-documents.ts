import type { PrismaClient } from '@prisma/client'
import { resolveDisclosureViewer } from '@nessie/runtime'
import {
  loadSpaceViewer, resolveTaskSetDocumentSource, resolveTaskSetArtifactDestination,
  type TaskSetKnowledgeAccess,
} from '@nessie/knowledge'
import type { AuthorizedActionContext, TaskSetOutput, TaskSetSource } from '@nessie/schemas'
import { assertTaskSetActor } from './task-set-access.js'

export const taskSetKnowledgeAccess = async (
  prisma: PrismaClient, actor: AuthorizedActionContext,
): Promise<TaskSetKnowledgeAccess> => {
  const { userId, decision } = await assertTaskSetActor(prisma, actor)
  const organizationId = actor.tenant.organizationId
  const disclosureViewer = await resolveDisclosureViewer(prisma, organizationId, userId, {
    allowStoredUoaIdentity: true, liveEntitlements: decision.entitlements,
  })
  const viewer = await loadSpaceViewer(prisma, organizationId, { actorType: 'user', actorId: userId }, {
    liveEntitlements: decision.entitlements, effectiveUserId: userId,
  })
  return { prisma, organizationId, actorType: 'user', disclosureViewer, viewer }
}

export const authorizeTaskSetSource = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, source: TaskSetSource,
) => resolveTaskSetDocumentSource(await taskSetKnowledgeAccess(prisma, actor), source)

export const authorizeTaskSetOutput = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, output: Exclude<TaskSetOutput, { kind: 'journal' }>,
) => resolveTaskSetArtifactDestination(await taskSetKnowledgeAccess(prisma, actor), output)
