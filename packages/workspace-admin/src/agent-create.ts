import { Prisma, type PrismaClient } from '@prisma/client'
import type { AgentEffort, AgentRecord, AgentRunLimits } from '@nessie/schemas'

import { assertGenericAgentToolPolicyInput } from './agent-tool-policy-core.js'
import { mapAgentRecord } from './agent-record.js'

// `Agent.runLimits` write value. `undefined` leaves the stored limits alone
// (the ordinary "field omitted" carry-forward), an explicit `null` clears them,
// and an object replaces them wholesale.
export const runLimitsWriteValue = (
  runLimits: AgentRunLimits | null | undefined,
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined => {
  if (runLimits === undefined) return undefined
  return runLimits ?? Prisma.DbNull
}

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const
const PERSONAL_ASSISTANT_SURFACE_POLICY = 'dm_only' as const
const PERSONAL_ASSISTANT_DELEGATION_MODE = 'act_as_requesting_user' as const

export const AGENT_MANAGEMENT_ERROR_CODES = {
  ORGANIZATION_REQUIRED: 'AGENT_ORGANIZATION_REQUIRED',
  PARENT_NOT_FOUND: 'AGENT_PARENT_NOT_FOUND',
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
export const createAgentRecord = async (
  prisma: PrismaClient,
  input: {
    agentKind?: 'personal_assistant' | 'shared'
    effort?: AgentEffort
    model?: string
    name: string
    organizationId: string
    parentAgentId?: string
    projectId?: string
    provider?: string
    role: string
    runLimits?: AgentRunLimits | null
    surfacePolicy?: 'dm_only' | 'shared'
    systemPrompt?: string
    systemManaged?: boolean
    delegationMode?: 'act_as_requesting_user' | 'none'
    teamId?: string
    toolPolicy?: Record<string, boolean>
  },
): Promise<AgentRecord> => {
  if (!input.organizationId) {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.ORGANIZATION_REQUIRED,
      'Shared agents require an organization.',
    )
  }

  if (
    input.agentKind === PERSONAL_ASSISTANT_AGENT_KIND
    || input.systemManaged === true
    || input.surfacePolicy === PERSONAL_ASSISTANT_SURFACE_POLICY
    || input.delegationMode === PERSONAL_ASSISTANT_DELEGATION_MODE
  ) {
    throw new Error('PERSONAL_ASSISTANT_CREATE_REQUIRES_BOOTSTRAP')
  }

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

  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      delegationMode: 'none',
      effort: input.effort ?? 'medium',
      model: input.model,
      name: input.name,
      organizationId: input.organizationId,
      parentAgentId: input.parentAgentId,
      projectId: input.projectId,
      provider: input.provider,
      role: input.role,
      runLimits: runLimitsWriteValue(input.runLimits),
      surfacePolicy: 'shared',
      systemPrompt: input.systemPrompt,
      systemManaged: false,
      teamId: input.teamId,
      toolPolicy: input.toolPolicy ?? undefined,
    },
    include: agentRecordInclude,
  })

  return mapAgentRecord(agent)
}
