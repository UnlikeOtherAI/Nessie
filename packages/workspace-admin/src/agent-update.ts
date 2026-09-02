import type { PrismaClient } from '@prisma/client'
import type {
  AgentAvatarBackgroundColor,
  AgentEffort,
  AgentRecord,
  AgentRunLimits,
} from '@nessie/schemas'

import {
  acquireAgentTodoAgentLock,
} from './agent-todo-lock.js'
import {
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
  assertAgentOwnerIsActiveMember,
  runLimitsWriteValue,
} from './agent-create.js'
import {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  AgentEditAuthorityError,
  assertAgentEditAuthority,
  assertAgentFieldAuthority,
  type AgentEditActor,
} from './agent-edit-authority.js'
import {
  acquireAgentToolPolicyLock,
  mergeGenericAgentToolPolicy,
} from './agent-tool-policy-core.js'
import { AGENT_OWNER_MEMBERSHIP_SELECT, mapAgentRecord } from './agent-record.js'

/**
 * Rewriting an agent, under the acting person's live authority.
 *
 * Shared rather than an API service because the Agent Designer's `agent_update`
 * and `agent_avatar_update` tools do exactly what a person does by clicking, and
 * `api/src/services/*` is unreachable from the worker — a second copy would fork
 * the field-sensitive refusals and the system-managed gate on day one.
 *
 * The actor is threaded in rather than checked only at the route because the
 * body carries fields with *different* authorities — `ownerUserId` and
 * `todosEnabled` are narrower than the rest — and an actor-less service cannot
 * express that.
 */

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const
const PERSONAL_ASSISTANT_SURFACE_POLICY = 'dm_only' as const
const PERSONAL_ASSISTANT_DELEGATION_MODE = 'act_as_requesting_user' as const

export type UpdateAgentRecordInput = {
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
}

export const updateAgentRecord = async (
  prisma: PrismaClient,
  agentId: string,
  actor: AgentEditActor,
  input: UpdateAgentRecordInput,
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

    // A blueprint-managed agent is refused HERE, not merely hidden by the
    // routes. Until now the only protection was route invisibility, while this
    // service happily rewrote a system row's prompt, policy and model if
    // anything ever reached it — and the Agent Designer plan deliberately widens
    // the read paths that kept it unreachable.
    if (existing.systemManaged) {
      throw new AgentEditAuthorityError(
        AGENT_EDIT_AUTHORITY_ERROR_CODES.SYSTEM_IMMUTABLE,
        'This agent is managed by Nessie itself and cannot be edited.',
      )
    }

    // Edit authority plus the two narrower field gates, over the row actually
    // being written and the live membership row — never the session claim.
    await assertAgentFieldAuthority(tx, actor, existing, {
      ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
      ...(input.todosEnabled === undefined ? {} : { todosEnabled: input.todosEnabled }),
    })

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
 * An agent's portrait follows the same edit authority as the rest of its
 * configuration — the live owner of a private or person-owned agent, anyone
 * entitled to a team-owned one, plus organization owners.
 */
export const updateAgentAvatar = async (
  prisma: PrismaClient,
  agentId: string,
  actor: AgentEditActor,
  avatarAttachmentId: string | null,
  avatarBackgroundColor?: AgentAvatarBackgroundColor,
): Promise<AgentRecord | null> => {
  const existing = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      systemManaged: true,
      visibility: true,
    },
  })
  if (!existing) {
    return null
  }
  // Refused in the service, not merely hidden by the route: a blueprint-managed
  // agent's face is part of its blueprint.
  if (existing.systemManaged) {
    throw new AgentEditAuthorityError(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.SYSTEM_IMMUTABLE,
      'This agent is managed by Nessie itself and cannot be edited.',
    )
  }
  await assertAgentEditAuthority(prisma, actor, existing)

  const agent = await prisma.agent.update({
    where: { id: agentId },
    data: {
      avatarAttachmentId,
      ...(avatarBackgroundColor !== undefined ? { avatarBackgroundColor } : {}),
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
}
