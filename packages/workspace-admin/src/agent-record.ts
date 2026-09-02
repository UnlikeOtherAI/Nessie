import type { Prisma } from '@prisma/client'
import {
  buildAgentVisibilityWhere,
  type AgentVisibilityScope,
} from '@nessie/db'
import type {
  AgentAvatarBackgroundColor,
  AgentEffort,
  AgentOwner,
  AgentOwnerState,
  AgentRecord,
  AgentRunLimits,
} from '@nessie/schemas'
import {
  AgentAvatarBackgroundColorSchema,
  AgentRunLimitsSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
} from '@nessie/schemas'
import { redactExplicitToolPolicyProvenance } from '@nessie/runtime'

const PERSONAL_ASSISTANT_AGENT_KIND = 'personal_assistant' as const

export type { AgentVisibilityScope } from '@nessie/db'

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

export { buildAgentVisibilityWhere }

export const isSystemManagedAgent = (agent: {
  agentKind: string
  systemManaged: boolean
}): boolean =>
  agent.systemManaged || agent.agentKind === PERSONAL_ASSISTANT_AGENT_KIND

/**
 * A stored `ownerUserId` names a membership row that exists — the composite
 * foreign key guarantees that much — but not one that is still entitled:
 * deactivated memberships are retained deliberately for audit history. So the
 * steward is resolved from the live row on every read, the same way
 * `resolveDisclosureViewer` refuses to trust retained channel/team rows.
 */
export const AGENT_OWNER_MEMBERSHIP_SELECT = {
  select: {
    deactivatedAt: true,
    userId: true,
    user: { select: { avatarAttachmentId: true, displayName: true } },
  },
} as const

type AgentOwnerMembershipRow = {
  deactivatedAt: Date | null
  userId: string
  user?: { avatarAttachmentId?: string | null; displayName?: string | null } | null
} | null

export const resolveAgentOwner = (
  ownerUserId: string | null | undefined,
  membership: AgentOwnerMembershipRow | undefined,
): AgentOwner | null => {
  if (!ownerUserId) return null
  // The pointer is set but no membership row came back — either the caller did
  // not include it or the row is unreachable. Say `unknown` rather than
  // inventing a lifecycle claim.
  const ownerState: AgentOwnerState = membership
    ? (membership.deactivatedAt === null ? 'active' : 'deactivated')
    : 'unknown'
  return {
    userId: ownerUserId,
    ownerState,
    ...(membership?.user?.displayName ? { displayName: membership.user.displayName } : {}),
    ...(membership?.user?.avatarAttachmentId
      ? { avatarAttachmentId: membership.user.avatarAttachmentId }
      : {}),
  }
}

const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined

const toToolPolicyRecord = (
  value: unknown,
): Record<string, boolean> | undefined => {
  const policy = redactExplicitToolPolicyProvenance(value)
  return Object.keys(policy).length > 0 ? policy : undefined
}

const readAgentAvatarBackgroundColor = (
  value: string | null | undefined,
): AgentAvatarBackgroundColor | undefined => {
  const parsed = AgentAvatarBackgroundColorSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
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
  avatarBackgroundColor?: string | null
  messages?: Array<{ createdAt: Date }>
  name: string
  ownerUserId?: string | null
  ownerMembership?: AgentOwnerMembershipRow
  parentAgentId: string | null
  role: string
  runs?: Array<{
    createdAt: Date
    id: string
    status:
      | 'cancelled'
      | 'completed'
      | 'failed'
      | 'pending'
      | 'running'
      | 'waiting_approval'
      | 'waiting_input'
    toolCalls: Array<{ endedAt: Date | null; startedAt: Date; toolName: string }>
  }>
  provider: string | null
  model: string | null
  effort: AgentEffort
  agentKind: 'personal_assistant' | 'shared'
  systemManaged: boolean
  systemSlug?: string | null
  visibility: 'private' | 'workspace'
  homeChannelId?: string
  surfacePolicy: 'dm_only' | 'shared'
  delegationMode: 'act_as_requesting_user' | 'none'
  status:
    | 'error'
    | 'executing'
    | 'idle'
    | 'offline'
    | 'thinking'
    | 'waiting_approval'
    | 'waiting_input'
  systemPrompt: string | null
  runLimits?: unknown
  todosEnabled: boolean
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

  const owner = resolveAgentOwner(agent.ownerUserId, agent.ownerMembership)

  return {
    id: parseAgentId(agent.id),
    name: agent.name,
    role: agent.role,
    status: agent.status,
    ownerUserId: agent.ownerUserId ?? null,
    owner,
    agentKind: agent.agentKind,
    systemManaged: agent.systemManaged,
    systemSlug: agent.systemSlug ?? null,
    visibility: agent.visibility,
    ...(agent.homeChannelId ? { homeChannelId: parseChannelId(agent.homeChannelId) } : {}),
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
    todosEnabled: agent.todosEnabled,
    toolPolicy: toToolPolicyRecord(agent.toolPolicy),
    avatarAttachmentId: agent.avatarAttachmentId ?? undefined,
    avatarBackgroundColor: readAgentAvatarBackgroundColor(agent.avatarBackgroundColor),
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    channelIds: agent.bindings.map((binding) =>
      parseChannelId(binding.channelId)),
  }
}
