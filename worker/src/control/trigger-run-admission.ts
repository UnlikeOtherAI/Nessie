import type { PrismaClient } from '@prisma/client'
import {
  activeTeamMatchesAttribution,
  loadLedgerIdentitySettings,
  loadLedgerUoaIdentity,
} from '@nessie/runtime'
import type { AgentTriggerType } from '@nessie/schemas'

import {
  assertTriggerExecutionOriginTenant,
  resolveTriggerExecutionOrigin,
  TriggerLaunchOriginError,
  type TriggerExecutionOrigin,
} from './trigger-origin.js'

// Whether this deployment signs Ledger calls is deployment state, not a
// per-trigger decision. Read it once, exactly as the run dispatcher does.
const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null

export type TriggerRunAdmissionInput = {
  agent: {
    agentKind: 'personal_assistant' | 'shared'
    organizationId: string | null
    projectId: string | null
    teamId: string | null
  }
  agentId: string
  config?: unknown
  targetChannelId: string
  targetThreadId: string
  triggerType: AgentTriggerType
}

export type TriggerRunAdmission = {
  executionOrigin: TriggerExecutionOrigin
  isPersonalAssistantTrigger: boolean
}

/**
 * Recheck every durable authority a trigger fire relies on.
 *
 * This is intentionally stricter than ordinary public-channel browsing. A
 * scheduled post is unattended authority captured from a person and an agent:
 * both must remain explicitly present in the destination roster. Removing
 * either principal therefore stops the schedule even though an active
 * organisation member may still browse and post manually in a public room.
 */
export const assertTriggerRunAdmission = async (
  prisma: PrismaClient,
  input: TriggerRunAdmissionInput,
): Promise<TriggerRunAdmission> => {
  const isPersonalAssistantTrigger = input.agent.agentKind === 'personal_assistant'
  const thread = await prisma.thread.findUnique({
    where: { id: input.targetThreadId },
    select: {
      channel: {
        select: {
          deletedAt: true,
          organizationId: true,
          systemChannelType: true,
          type: true,
          visibility: true,
        },
      },
      channelId: true,
    },
  })
  if (
    !thread
    || thread.channelId !== input.targetChannelId
    || thread.channel.deletedAt !== null
  ) {
    throw new TriggerLaunchOriginError(
      'agent_channel_access_lost',
      'its target channel or thread no longer exists',
    )
  }

  // A PA delegates its owner's authority and is not an ordinary shared-agent
  // channel member. Only that binding check is exempted; its owner is checked
  // below under the same human-membership rule as every saved launcher.
  if (!isPersonalAssistantTrigger) {
    const binding = await prisma.agentBinding.findFirst({
      where: {
        agentId: input.agentId,
        channelId: input.targetChannelId,
      },
      select: { id: true },
    })
    if (!binding) {
      throw new TriggerLaunchOriginError(
        'agent_channel_access_lost',
        'its agent is no longer in the target channel',
      )
    }
  }

  const executionOrigin = resolveTriggerExecutionOrigin({
    agent: input.agent,
    channelOrganizationId: thread.channel.organizationId,
    config: input.config,
    triggerType: input.triggerType,
  })
  await assertTriggerExecutionOriginTenant(prisma, executionOrigin)

  // Pre-flight exactly the Ledger identity the run would sign with. A schedule
  // that can never authenticate stops here instead of creating a doomed run.
  if (ledgerSigningConfigured && executionOrigin.userId) {
    const identity = executionOrigin.uoaIdentity
      ? await loadLedgerUoaIdentity(prisma, {
          actorId: executionOrigin.userId,
          actorType: 'user',
          organizationId: executionOrigin.organizationId,
          uoaIdentity: executionOrigin.uoaIdentity,
          userId: executionOrigin.userId,
        })
      : null
    if (!identity) {
      throw new TriggerLaunchOriginError(
        'uoa_identity_unverifiable',
        'its saved UnlikeOtherAI identity is missing or no longer valid',
      )
    }
    const teamMatches = await activeTeamMatchesAttribution(
      prisma,
      {
        actorId: executionOrigin.userId,
        actorType: 'user',
        organizationId: executionOrigin.organizationId,
        ...(executionOrigin.teamId ? { teamId: executionOrigin.teamId } : {}),
        userId: executionOrigin.userId,
      },
      identity,
    )
    if (!teamMatches) {
      throw new TriggerLaunchOriginError(
        'uoa_identity_unverifiable',
        'its saved UnlikeOtherAI team no longer maps to its team',
      )
    }
  }

  if (executionOrigin.userId) {
    const membership = await prisma.channelMember.findFirst({
      where: {
        channelId: input.targetChannelId,
        userId: executionOrigin.userId,
      },
      select: { userId: true },
    })
    if (!membership) {
      throw new TriggerLaunchOriginError(
        'channel_access_lost',
        'its saved user is no longer a member of the target channel',
      )
    }
  }

  return { executionOrigin, isPersonalAssistantTrigger }
}

export const isAgentChannelAdmissionError = (error: unknown): boolean =>
  error instanceof TriggerLaunchOriginError
  && error.reason === 'agent_channel_access_lost'
