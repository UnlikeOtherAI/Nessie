import type { PrismaClient } from '@prisma/client'
import { resolveDisclosureViewer } from '@nessie/runtime'
import {
  loadSpaceViewer, resolveTaskSetDocumentSource, resolveTaskSetArtifactDestination,
  type TaskSetKnowledgeAccess,
} from '@nessie/knowledge'
import type { AuthorizedActionContext, TaskSetOutput, TaskSetSource } from '@nessie/schemas'
import { assertTaskSetActor } from './task-set-authority.js'

export const taskSetKnowledgeAccess = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, options: { processingAgentId?: string } = {},
): Promise<TaskSetKnowledgeAccess> => {
  const { userId, decision } = await assertTaskSetActor(prisma, actor)
  const organizationId = actor.tenant.organizationId
  const disclosureViewer = await resolveDisclosureViewer(prisma, organizationId, userId, {
    allowStoredUoaIdentity: true, liveEntitlements: decision.entitlements,
  })
  const principal = options.processingAgentId
    ? { actorType: 'agent' as const, actorId: options.processingAgentId }
    : { actorType: 'user' as const, actorId: userId }
  const viewer = await loadSpaceViewer(prisma, organizationId, principal, {
    liveEntitlements: decision.entitlements, effectiveUserId: userId,
  })
  return { prisma, organizationId, actorType: principal.actorType, disclosureViewer, viewer }
}

export const authorizeTaskSetSource = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, source: TaskSetSource,
  options: { processingAgentId?: string } = {},
) => {
  const human = await resolveTaskSetDocumentSource(await taskSetKnowledgeAccess(prisma, actor), source)
  if (options.processingAgentId) {
    await resolveTaskSetDocumentSource(await taskSetKnowledgeAccess(prisma, actor, options), source)
  }
  return human
}

export const authorizeTaskSetOutput = async (
  prisma: PrismaClient, actor: AuthorizedActionContext, output: Exclude<TaskSetOutput, { kind: 'journal' }>,
  options: { processingAgentId?: string } = {},
) => {
  const human = await resolveTaskSetArtifactDestination(await taskSetKnowledgeAccess(prisma, actor), output)
  if (options.processingAgentId) {
    await resolveTaskSetArtifactDestination(await taskSetKnowledgeAccess(prisma, actor, options), output)
  }
  return human
}
