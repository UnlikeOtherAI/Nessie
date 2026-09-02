import type { PrismaClient } from '@prisma/client'
import {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentEditAuthorityError,
  AgentManagementError,
  agentRecordInclude,
  assertAgentFieldAuthority,
  assertAgentOwnerIsActiveMember,
  canEditAgent,
  createAgentRecord,
  isSystemManagedAgent,
  listAgentsForUser,
  mapAgentRecord,
  randomAgentAvatarBackgroundColor,
  readAgentRecordForActor,
  readAgentRunLimits,
  resolveAgentEditAuthority,
  runLimitsWriteValue,
  stripProtectedAgentToolPolicy,
  updateAgentRecord,
  validateAgentCreateInput,
  type AgentEditActor,
} from '@nessie/workspace-admin'

import type { AgentRecord } from '../contracts.js'

// Agent creation and the entitlement-scoped agent list are shared with the
// worker (the assistant's `agent_create` and `agent_list` tools); the route
// keeps importing them from here. Edit authority is shared for the same reason:
// the routes and the Designer's future `agent_update` must not be able to
// disagree about who may rewrite an agent.
export {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentEditAuthorityError,
  AgentManagementError,
  assertAgentFieldAuthority,
  canEditAgent,
  createAgentRecord,
  listAgentsForUser,
  readAgentRecordForActor,
  resolveAgentEditAuthority,
  updateAgentRecord,
  validateAgentCreateInput,
}
export type { AgentEditActor }

/**
 * A clone belongs to whoever cloned it, not to the source's steward: the copy
 * is that person's to configure and run, and inheriting someone else's
 * ownership would hand them an agent they never asked for (ownership is also
 * the escalation anchor). Consistent with the existing decision that a clone
 * drops `parentAgentId` and is always a root.
 */
export const cloneAgentRecord = async (
  prisma: PrismaClient,
  sourceAgentId: string,
  organizationId: string,
  clonedByUserId?: string,
): Promise<AgentRecord | null> => {
  const source = await prisma.agent.findFirst({
    where: {
      id: sourceAgentId,
      organizationId,
    },
    select: {
      agentKind: true,
      delegationMode: true,
      effort: true,
      model: true,
      name: true,
      organizationId: true,
      provider: true,
      projectId: true,
      role: true,
      runLimits: true,
      surfacePolicy: true,
      systemManaged: true,
      systemPrompt: true,
      teamId: true,
      todosEnabled: true,
      toolPolicy: true,
      modelSubscriptionId: true,
    },
  })
  if (!source || isSystemManagedAgent(source)) return null

  // A clone belongs to whoever cloned it, and a personal subscription is not
  // transferable: the copy would otherwise spend the ORIGINAL owner's plan.
  // Both halves of the selection are dropped together so the copy falls back to
  // the deployment default rather than becoming a broken agent.
  const clonesSubscription = source.modelSubscriptionId !== null

  const toolPolicy = await stripProtectedAgentToolPolicy(
    prisma,
    source.toolPolicy,
  )
  if (source.organizationId) {
    await assertAgentOwnerIsActiveMember(prisma, source.organizationId, clonedByUserId)
  }
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      avatarBackgroundColor: randomAgentAvatarBackgroundColor(),
      delegationMode: 'none',
      effort: source.effort,
      model: clonesSubscription ? null : source.model,
      name: `${source.name} (copy)`,
      organizationId: source.organizationId,
      ownerUserId: clonedByUserId,
      provider: clonesSubscription ? null : source.provider,
      projectId: source.projectId,
      role: source.role,
      // Run limits are ordinary agent configuration (not a protected key), so a
      // clone inherits them the same way it inherits effort/model.
      runLimits: runLimitsWriteValue(readAgentRunLimits(source.runLimits)),
      surfacePolicy: 'shared',
      systemPrompt: source.systemPrompt,
      systemManaged: false,
      teamId: source.teamId,
      todosEnabled: source.todosEnabled,
      toolPolicy,
    },
    include: agentRecordInclude,
  })

  return mapAgentRecord(agent)
}
