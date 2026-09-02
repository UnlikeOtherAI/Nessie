import type { PrismaClient } from '@prisma/client'
import type {
  AgentEffort,
  AgentRunLimits,
} from '@nessie/schemas'
import {
  acquireAgentToolPolicyLock,
  acquireAgentTodoAgentLock,
  AGENT_MANAGEMENT_ERROR_CODES,
  AGENT_OWNER_MEMBERSHIP_SELECT,
  AgentManagementError,
  agentRecordInclude,
  assertAgentOwnerIsActiveMember,
  createAgentRecord,
  isSystemManagedAgent,
  listAgentsForUser,
  mapAgentRecord,
  mergeGenericAgentToolPolicy,
  randomAgentAvatarBackgroundColor,
  readAgentRunLimits,
  runLimitsWriteValue,
  stripProtectedAgentToolPolicy,
  validateAgentCreateInput,
} from '@nessie/workspace-admin'

import type { AgentRecord } from '../contracts.js'

// Agent creation and the entitlement-scoped agent list are shared with the
// worker (the assistant's `agent_create` and `agent_list` tools); the route
// keeps importing them from here.
export {
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
  createAgentRecord,
  listAgentsForUser,
  validateAgentCreateInput,
}

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const
const PERSONAL_ASSISTANT_SURFACE_POLICY = 'dm_only' as const
const PERSONAL_ASSISTANT_DELEGATION_MODE = 'act_as_requesting_user' as const

export const updateAgentRecord = async (
  prisma: PrismaClient,
  agentId: string,
  input: {
    agentKind?: 'personal_assistant' | 'shared'
    effort?: AgentEffort
    model?: string
    /**
     * `undefined` leaves the pointer alone; `null` clears it. The validator
     * always returns an explicit value when the model/provider pair is being
     * written, so a Ledger selection actively clears a stale subscription.
     */
    modelSubscriptionId?: string | null
    name?: string
    /** undefined = leave stewardship alone; null = return to the unowned pool. */
    ownerUserId?: string | null
    provider?: string
    role?: string
    runLimits?: AgentRunLimits | null
    todosEnabled?: boolean
    surfacePolicy?: 'dm_only' | 'shared'
    systemPrompt?: string
    systemManaged?: boolean
    delegationMode?: 'act_as_requesting_user' | 'none'
    organizationId: string
    toolPolicy?: Record<string, boolean>
  },
): Promise<AgentRecord | null> =>
  prisma.$transaction(async (tx) => {
    await acquireAgentToolPolicyLock(tx, agentId)
    const existing = await tx.agent.findFirst({
      where: {
        id: agentId,
        organizationId: input.organizationId,
      },
    })
    if (!existing) return null

    // A transfer is any change of steward to a different person (or to the
    // unowned pool) on an agent currently running on a personal subscription.
    const transfersOwnership =
      existing.modelSubscriptionId !== null
      && input.ownerUserId !== undefined
      && input.ownerUserId !== existing.ownerUserId

    if (existing.todosEnabled && input.todosEnabled === false) {
      await acquireAgentTodoAgentLock(tx, agentId)
      const enabledTriggers = await tx.agentTrigger.findMany({
        select: { config: true },
        where: { agentId, enabled: true },
      })
      if (enabledTriggers.some((trigger) => {
        const config = trigger.config
        return typeof config === 'object'
          && config !== null
          && !Array.isArray(config)
          && typeof config['todoTemplateId'] === 'string'
      })) {
        throw new AgentManagementError(
          AGENT_MANAGEMENT_ERROR_CODES.TODOS_IN_USE,
          'Pause enabled schedules that use to-do templates before disabling to-dos.',
        )
      }
    }

    // A private agent's immutable owner is encoded in its owner-only home DM.
    // Re-homing that surface is a disclosure-changing operation, so v1 makes
    // the caller publish first instead of leaving a broken or orphaned home.
    if (input.ownerUserId !== undefined && existing.visibility === 'private') {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_TRANSFER_UNSUPPORTED,
        'Private agents cannot be transferred. Publish the agent before transferring it.',
      )
    }

    if (
      input.agentKind === PERSONAL_ASSISTANT_AGENT_KIND
      || input.systemManaged === true
      || input.surfacePolicy === PERSONAL_ASSISTANT_SURFACE_POLICY
      || input.delegationMode === PERSONAL_ASSISTANT_DELEGATION_MODE
    ) {
      throw new Error('PERSONAL_ASSISTANT_UPDATE_REQUIRES_BOOTSTRAP')
    }

    const toolPolicy = input.toolPolicy === undefined
      ? existing.toolPolicy
      : await mergeGenericAgentToolPolicy(
          tx,
          existing.toolPolicy,
          input.toolPolicy,
        )

    // A system-managed agent has no steward by construction (the CHECK would
    // refuse), and a transfer target must be an active member of THIS agent's
    // organization — refused in words here rather than as a raw constraint
    // violation.
    if (input.ownerUserId !== undefined && !existing.systemManaged) {
      await assertAgentOwnerIsActiveMember(
        tx,
        input.organizationId,
        input.ownerUserId ?? undefined,
      )
    }
    const agent = await tx.agent.update({
      where: { id: agentId },
      data: {
        agentKind: existing.agentKind,
        delegationMode: existing.delegationMode,
        effort: input.effort ?? existing.effort,
        model: transfersOwnership ? null : input.model ?? existing.model,
        // An owner transfer takes the agent off the previous owner's personal
        // plan. Clearing all three together is what stops the new owner
        // inheriting spend on somebody else's subscription; the run-time gate
        // would refuse it anyway, but a silently broken agent is a worse
        // outcome than one that falls back to the deployment default.
        modelSubscriptionId: transfersOwnership
          ? null
          : input.modelSubscriptionId === undefined
            ? existing.modelSubscriptionId
            : input.modelSubscriptionId,
        name: existing.systemManaged
          ? existing.name
          : input.name ?? existing.name,
        ownerUserId: existing.systemManaged
          ? existing.ownerUserId
          : input.ownerUserId === undefined
            ? existing.ownerUserId
            : input.ownerUserId,
        provider: transfersOwnership ? null : input.provider ?? existing.provider,
        role: input.role ?? existing.role,
        runLimits: runLimitsWriteValue(input.runLimits),
        surfacePolicy: existing.surfacePolicy,
        systemPrompt: input.systemPrompt ?? existing.systemPrompt,
        systemManaged: existing.systemManaged,
        todosEnabled: existing.systemManaged
          ? existing.todosEnabled
          : input.todosEnabled ?? existing.todosEnabled,
        toolPolicy: toolPolicy ?? undefined,
      },
      include: {
        ownerMembership: AGENT_OWNER_MEMBERSHIP_SELECT,
        bindings: {
          orderBy: { createdAt: 'asc' },
          select: { channelId: true },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
          take: 1,
        },
        runs: {
          include: {
            toolCalls: {
              orderBy: { startedAt: 'desc' },
              select: {
                endedAt: true,
                startedAt: true,
                toolName: true,
              },
              take: 1,
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })

    return mapAgentRecord(agent)
  })

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
