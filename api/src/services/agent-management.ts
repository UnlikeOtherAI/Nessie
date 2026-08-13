import type { PrismaClient } from '@prisma/client'
import type {
  AgentEffort,
  AgentRunLimits,
} from '@nessie/schemas'
import {
  acquireAgentToolPolicyLock,
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
  agentRecordInclude,
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
    name?: string
    provider?: string
    role?: string
    runLimits?: AgentRunLimits | null
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
    const agent = await tx.agent.update({
      where: { id: agentId },
      data: {
        agentKind: existing.agentKind,
        delegationMode: existing.delegationMode,
        effort: input.effort ?? existing.effort,
        model: input.model ?? existing.model,
        name: existing.systemManaged
          ? existing.name
          : input.name ?? existing.name,
        provider: input.provider ?? existing.provider,
        role: input.role ?? existing.role,
        runLimits: runLimitsWriteValue(input.runLimits),
        surfacePolicy: existing.surfacePolicy,
        systemPrompt: input.systemPrompt ?? existing.systemPrompt,
        systemManaged: existing.systemManaged,
        toolPolicy: toolPolicy ?? undefined,
      },
      include: {
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

export const cloneAgentRecord = async (
  prisma: PrismaClient,
  sourceAgentId: string,
  organizationId: string,
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
      toolPolicy: true,
    },
  })
  if (!source || isSystemManagedAgent(source)) return null

  const toolPolicy = await stripProtectedAgentToolPolicy(
    prisma,
    source.toolPolicy,
  )
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      avatarBackgroundColor: randomAgentAvatarBackgroundColor(),
      delegationMode: 'none',
      effort: source.effort,
      model: source.model,
      name: `${source.name} (copy)`,
      organizationId: source.organizationId,
      provider: source.provider,
      projectId: source.projectId,
      role: source.role,
      // Run limits are ordinary agent configuration (not a protected key), so a
      // clone inherits them the same way it inherits effort/model.
      runLimits: runLimitsWriteValue(readAgentRunLimits(source.runLimits)),
      surfacePolicy: 'shared',
      systemPrompt: source.systemPrompt,
      systemManaged: false,
      teamId: source.teamId,
      toolPolicy,
    },
    include: agentRecordInclude,
  })

  return mapAgentRecord(agent)
}
