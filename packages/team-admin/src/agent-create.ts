import { randomInt } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AGENT_AVATAR_BACKGROUND_COLORS,
  type AgentAvatarBackgroundColor,
  type AgentEffort,
  type AgentRecord,
  type AgentRunLimits,
  type AgentVisibility,
} from '@nessie/schemas'

import { assertGenericAgentToolPolicyInput } from './agent-tool-policy-core.js'
import { AGENT_OWNER_MEMBERSHIP_SELECT, mapAgentRecord } from './agent-record.js'
import { ensurePrivateAgentHome } from './private-agent-home.js'

// `Agent.runLimits` write value. `undefined` leaves the stored limits alone
// (the ordinary "field omitted" carry-forward), an explicit `null` clears them,
// and an object replaces them wholesale.
export const runLimitsWriteValue = (
  runLimits: AgentRunLimits | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined => {
  if (runLimits === undefined) return undefined
  return runLimits ?? Prisma.DbNull
}

/**
 * `Agent.speakingStyle` write value: whitespace is not a style.
 *
 * A cleared textarea posts `''`, and storing that would leave a row that is
 * "set" but contributes an empty prompt block, so the two states a person can
 * see (chosen / not chosen) would stop matching the two the column can hold.
 */
export const speakingStyleWriteValue = (
  style: string | null | undefined,
): string | null | undefined => {
  if (style === undefined) return undefined
  return style?.trim() ? style.trim() : null
}

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const
const PERSONAL_ASSISTANT_SURFACE_POLICY = 'dm_only' as const
const PERSONAL_ASSISTANT_DELEGATION_MODE = 'act_as_requesting_user' as const

export const randomAgentAvatarBackgroundColor = (): AgentAvatarBackgroundColor =>
  AGENT_AVATAR_BACKGROUND_COLORS[
    randomInt(AGENT_AVATAR_BACKGROUND_COLORS.length)
  ]!

export const AGENT_MANAGEMENT_ERROR_CODES = {
  ORGANIZATION_REQUIRED: 'AGENT_ORGANIZATION_REQUIRED',
  OWNER_NOT_A_MEMBER: 'AGENT_OWNER_NOT_A_MEMBER',
  PARENT_NOT_FOUND: 'AGENT_PARENT_NOT_FOUND',
  PRIVATE_OWNER_REQUIRED: 'AGENT_PRIVATE_OWNER_REQUIRED',
  PRIVATE_TRANSFER_UNSUPPORTED: 'AGENT_PRIVATE_TRANSFER_UNSUPPORTED',
  TODOS_IN_USE: 'AGENT_TODOS_IN_USE',
} as const

export class AgentManagementError extends Error {
  override readonly name = 'AgentManagementError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

// Shape of the row every agent read returns, kept next to the writer so a new
// field is mapped the same way whichever surface created the agent.
export const agentRecordInclude = {
  bindings: {
    select: { channelId: true },
  },
  ownerMembership: AGENT_OWNER_MEMBERSHIP_SELECT,
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
} satisfies Prisma.AgentInclude

/**
 * Create a shared agent. Used by `POST /api/agents` and by the personal
 * assistant's `agent_create` tool, so an agent described in chat is the same
 * record the Agent Designer would have written — including the refusal of
 * personal-assistant provenance and of protected tool-policy keys.
 */
export type CreateAgentRecordInput = {
  agentKind?: 'personal_assistant' | 'shared'
  avatarAttachmentId?: string
  avatarBackgroundColor?: AgentAvatarBackgroundColor
  effort?: AgentEffort
  model?: string
  /** Which linked personal subscription this agent spends, if any. */
  modelSubscriptionId?: string | null
  name: string
  organizationId: string
  /**
   * The person this agent belongs to. Every human-initiated path supplies it —
   * `POST /api/agents` from the session actor, the assistant's `agent_create`
   * from the live acting member — so a member never loses sight of an agent
   * they just made. Omitted only where no acting person exists (seeds,
   * bootstraps), which leaves the agent unowned rather than mis-attributed.
   */
  ownerUserId?: string
  parentAgentId?: string
  projectId?: string
  provider?: string
  role: string
  runLimits?: AgentRunLimits | null
  todosEnabled?: boolean
  /** One of `GEMINI_LIVE_VOICES`; omitted leaves the deployment default. */
  voiceName?: string | null
  /** How the agent talks to people. Prompt text, never a preset id. */
  speakingStyle?: string | null
  surfacePolicy?: 'dm_only' | 'shared'
  systemPrompt?: string
  systemManaged?: boolean
  delegationMode?: 'act_as_requesting_user' | 'none'
  teamId?: string
  toolPolicy?: Record<string, boolean>
  visibility?: AgentVisibility
}

/**
 * The owner must be an active member of the agent's organization. The composite
 * foreign key already makes a cross-tenant owner impossible, and the retained
 * deactivated row would satisfy it — so this check exists to refuse in words,
 * and to catch deactivation, rather than to be the only line of defence.
 */
export const assertAgentOwnerIsActiveMember = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  ownerUserId: string | undefined,
): Promise<void> => {
  if (!ownerUserId) return
  const membership = await prisma.organizationMember.findFirst({
    where: { deactivatedAt: null, organizationId, userId: ownerUserId },
    select: { id: true },
  })
  if (!membership) {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.OWNER_NOT_A_MEMBER,
      'An agent can only be owned by an active member of its organization.',
    )
  }
}

/** Validate creation before a route spends on optional follow-on work. */
export const validateAgentCreateInput = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  input: Pick<
    CreateAgentRecordInput,
    'organizationId' | 'ownerUserId' | 'parentAgentId' | 'toolPolicy' | 'visibility'
  >,
): Promise<void> => {
  if (!input.organizationId) {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.ORGANIZATION_REQUIRED,
      'Shared agents require an organization.',
    )
  }

  if (input.visibility === 'private' && !input.ownerUserId) {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_OWNER_REQUIRED,
      'Private agents require an owner.',
    )
  }

  await assertAgentOwnerIsActiveMember(prisma, input.organizationId, input.ownerUserId)

  if (input.parentAgentId) {
    const parent = await prisma.agent.findFirst({
      where: {
        id: input.parentAgentId,
        organizationId: input.organizationId,
        systemManaged: false,
      },
      select: { id: true },
    })
    if (!parent) {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.PARENT_NOT_FOUND,
        'Parent agent not found.',
      )
    }
  }

  await assertGenericAgentToolPolicyInput(prisma, input.toolPolicy)
}

export const createAgentRecord = async (
  prisma: PrismaClient,
  input: CreateAgentRecordInput,
): Promise<AgentRecord> => {
  if (
    input.agentKind === PERSONAL_ASSISTANT_AGENT_KIND
    || input.systemManaged === true
    || input.surfacePolicy === PERSONAL_ASSISTANT_SURFACE_POLICY
    || input.delegationMode === PERSONAL_ASSISTANT_DELEGATION_MODE
  ) {
    throw new Error('PERSONAL_ASSISTANT_CREATE_REQUIRES_BOOTSTRAP')
  }

  const visibility = input.visibility ?? 'team'
  const createData = (): Prisma.AgentUncheckedCreateInput => ({
    agentKind: 'shared',
    avatarAttachmentId: input.avatarAttachmentId,
    avatarBackgroundColor: input.avatarBackgroundColor ?? randomAgentAvatarBackgroundColor(),
    delegationMode: 'none',
    effort: input.effort ?? 'medium',
    model: input.model,
    modelSubscriptionId: input.modelSubscriptionId ?? null,
    name: input.name,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    parentAgentId: input.parentAgentId,
    projectId: input.projectId,
    provider: input.provider,
    role: input.role,
    runLimits: runLimitsWriteValue(input.runLimits),
    surfacePolicy: 'shared',
    systemPrompt: input.systemPrompt,
    systemManaged: false,
    teamId: input.teamId,
    todosEnabled: input.todosEnabled ?? false,
    voiceName: input.voiceName ?? null,
    speakingStyle: speakingStyleWriteValue(input.speakingStyle) ?? null,
    toolPolicy: input.toolPolicy ?? undefined,
    visibility,
  })

  // Preserve the ordinary team-agent write path. Private creation alone
  // needs the encompassing transaction because its home is part of the agent's
  // creation invariant, not a follow-up repair.
  if (visibility === 'team') {
    await validateAgentCreateInput(prisma, input)
    const agent = await prisma.agent.create({
      data: createData(),
      include: agentRecordInclude,
    })
    return mapAgentRecord(agent)
  }

  return prisma.$transaction(async (tx) => {
    await validateAgentCreateInput(tx, input)
    const ownerUserId = input.ownerUserId
    if (!ownerUserId) {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_OWNER_REQUIRED,
        'Private agents require an owner.',
      )
    }
    const agent = await tx.agent.create({
      data: createData(),
      select: { id: true },
    })
    const homeChannelId = await ensurePrivateAgentHome(tx, {
      agentId: agent.id,
      label: input.name,
      organizationId: input.organizationId,
      ownerUserId,
      teamId: input.teamId,
    })
    const record = await tx.agent.findUniqueOrThrow({
      where: { id: agent.id },
      include: agentRecordInclude,
    })
    return mapAgentRecord({ ...record, homeChannelId })
  })
}
