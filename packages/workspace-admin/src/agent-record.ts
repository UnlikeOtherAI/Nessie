import type { Prisma } from '@prisma/client'
import type { AgentEffort, AgentRecord, AgentRunLimits } from '@nessie/schemas'
import {
  AgentRunLimitsSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
} from '@nessie/schemas'
import { redactExplicitToolPolicyProvenance } from '@nessie/runtime'

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const

export type AgentVisibilityScope = {
  includeAllOrgChannels?: boolean
  organizationId: string
  userId: string
}

export const buildAccessibleChannelWhere = (
  visibility: AgentVisibilityScope,
): Prisma.ChannelWhereInput => ({
  organizationId: visibility.organizationId,
  ...(visibility.includeAllOrgChannels
    ? {}
    : {
        OR: [
          { visibility: 'public' },
          { members: { some: { userId: visibility.userId } } },
        ],
      }),
})

export const buildAccessibleThreadWhere = (
  visibility: AgentVisibilityScope,
): Prisma.ThreadWhereInput => ({
  channel: buildAccessibleChannelWhere(visibility),
})

export const isSystemManagedAgent = (agent: {
  agentKind: string
  systemManaged: boolean
}): boolean =>
  agent.systemManaged || agent.agentKind === PERSONAL_ASSISTANT_AGENT_KIND

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

const toToolPolicyRecord = (
  value: unknown,
): Record<string, boolean> | undefined => {
  const policy = redactExplicitToolPolicyProvenance(value)
  return Object.keys(policy).length > 0 ? policy : undefined
}

/**
 * Read the stored `Agent.runLimits` JSON back through the shared schema. A row
 * written before the column existed (or hand-edited into a shape the contract
 * no longer accepts) reads as "no explicit limits" rather than leaking an
 * unvalidated blob into API responses.
 */
export const readAgentRunLimits = (value: unknown): AgentRunLimits | null => {
  if (value === null || value === undefined) return null
  const parsed = AgentRunLimitsSchema.safeParse(value)
  if (!parsed.success || Object.keys(parsed.data).length === 0) return null
  return parsed.data
}

export const mapAgentRecord = (agent: {
  bindings: Array<{ channelId: string }>
  createdAt: Date
  id: string
  avatarAttachmentId: string | null
  messages?: Array<{ createdAt: Date }>
  name: string
  parentAgentId: string | null
  role: string
  runs?: Array<{
    createdAt: Date
    id: string
    status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running' | 'waiting_approval'
    toolCalls: Array<{ endedAt: Date | null; startedAt: Date; toolName: string }>
  }>
  provider: string | null
  model: string | null
  effort: AgentEffort
  agentKind: 'personal_assistant' | 'shared'
  systemManaged: boolean
  surfacePolicy: 'dm_only' | 'shared'
  delegationMode: 'act_as_requesting_user' | 'none'
  status: 'error' | 'executing' | 'idle' | 'offline' | 'thinking' | 'waiting_approval'
  systemPrompt: string | null
  runLimits?: unknown
  toolPolicy?: unknown
  updatedAt: Date
}): AgentRecord => {
  const latestRun = agent.runs?.[0]
  const latestToolCall = latestRun?.toolCalls[0]
  const latestMessage = agent.messages?.[0]
  const isActiveRun =
    latestRun !== undefined
    && latestRun.status !== 'completed'
    && latestRun.status !== 'failed'
    && latestRun.status !== 'cancelled'
  const lastActivityAt =
    latestToolCall?.startedAt
    ?? latestMessage?.createdAt
    ?? latestRun?.createdAt
    ?? agent.updatedAt

  return {
    id: parseAgentId(agent.id),
    name: agent.name,
    role: agent.role,
    status: agent.status,
    agentKind: agent.agentKind,
    systemManaged: agent.systemManaged,
    surfacePolicy: agent.surfacePolicy,
    delegationMode: agent.delegationMode,
    currentRunId: isActiveRun ? parseRunId(latestRun.id) : undefined,
    currentToolName:
      isActiveRun && latestToolCall?.endedAt === null
        ? latestToolCall.toolName
        : undefined,
    currentToolStartedAt:
      isActiveRun && latestToolCall?.endedAt === null
        ? toTimestamp(latestToolCall.startedAt)
        : undefined,
    lastActivityAt: lastActivityAt.toISOString(),
    systemPrompt: agent.systemPrompt ?? undefined,
    parentAgentId: agent.parentAgentId
      ? parseAgentId(agent.parentAgentId)
      : undefined,
    provider: agent.provider ?? undefined,
    model: agent.model ?? undefined,
    effort: agent.effort,
    runLimits: readAgentRunLimits(agent.runLimits) ?? undefined,
    toolPolicy: toToolPolicyRecord(agent.toolPolicy),
    avatarAttachmentId: agent.avatarAttachmentId ?? undefined,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    channelIds: agent.bindings.map((binding) =>
      parseChannelId(binding.channelId)),
  }
}
