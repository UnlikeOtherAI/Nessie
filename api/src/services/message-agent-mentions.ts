import type { PrismaClient } from '@prisma/client'
import { mentionedAgentIdsFromContent } from '@nessie/runtime'
import type { AgentMention } from '@nessie/schemas'
import { buildAgentVisibilityWhere } from '@nessie/team-admin'

import { ChannelPostForbiddenError } from './channel-posting-policy.js'

export type ChannelAgent = {
  id: string
  name: string
  principalUserId?: string
  role: string
  systemPrompt: string | null
}

type AgentMentionChannel = {
  adminOnlyPosting: boolean
  organizationId: string
  systemChannelType: string | null
  agentBindings: Array<{
    principalUserId: string | null
    agent: { agentKind: string; id: string; name: string; role: string; systemPrompt: string | null }
  }>
}

export type ResolvedAgentMentions = {
  kind: 'valid'
  agentMentions: AgentMention[]
  ordinaryMentionIds: string[]
  boundOrdinaryIds: Set<string>
  structuredOrdinaryAgents: Map<string, { id: string; name: string }>
  channelAgents: ChannelAgent[]
  mentionedAgentIds: string[]
}

/** Validate structural agent identities before any message side effect. */
export const resolveAgentMentionsForSend = async (
  prisma: PrismaClient,
  input: { channel: AgentMentionChannel; content: string; userId: string;
    agentMentions?: AgentMention[] },
): Promise<ResolvedAgentMentions | { kind: 'invalid' }> => {
  const { channel } = input
  const agentMentions = [...new Map(
    (input.agentMentions ?? []).map((mention) => [
      `${mention.agentId}:${mention.principalUserId ?? ''}`, mention,
    ]),
  ).values()]
  if (channel.adminOnlyPosting && agentMentions.length > 0) {
    throw new ChannelPostForbiddenError('Agents cannot reply in a read-only channel')
  }
  const validPresenceMentionKeys = new Set(channel.agentBindings.flatMap((binding) =>
    binding.principalUserId && binding.agent.agentKind === 'personal_assistant'
      ? [`${binding.agent.id}:${binding.principalUserId}`]
      : [],
  ))
  const presenceMentions = agentMentions.filter(
    (mention): mention is AgentMention & { principalUserId: string } =>
      mention.principalUserId !== undefined,
  )
  if (presenceMentions.some((mention) =>
    !validPresenceMentionKeys.has(`${mention.agentId}:${mention.principalUserId}`))) {
    return { kind: 'invalid' }
  }
  const ordinaryMentionIds = [...new Set(agentMentions
    .filter((mention) => mention.principalUserId === undefined)
    .map((mention) => mention.agentId))]
  const boundOrdinaryAgents = channel.agentBindings.flatMap((binding) =>
    !binding.principalUserId && binding.agent.agentKind !== 'personal_assistant'
      ? [{ id: binding.agent.id, name: binding.agent.name }]
      : [],
  )
  const boundOrdinaryIds = new Set(boundOrdinaryAgents.map((agent) => agent.id))
  const unboundMentionIds = ordinaryMentionIds.filter((id) => !boundOrdinaryIds.has(id))
  if (channel.systemChannelType && unboundMentionIds.length > 0) return { kind: 'invalid' }
  const unboundMentionAgents = unboundMentionIds.length > 0
    ? await prisma.agent.findMany({
      where: {
        AND: [buildAgentVisibilityWhere({
          organizationId: channel.organizationId, userId: input.userId,
        })],
        agentKind: 'shared', executionMode: { not: 'external_mcp' },
        id: { in: unboundMentionIds }, organizationId: channel.organizationId,
      },
      select: { id: true, name: true },
    })
    : []
  if (unboundMentionAgents.length !== unboundMentionIds.length) return { kind: 'invalid' }
  const structuredOrdinaryAgents = new Map(
    [...boundOrdinaryAgents, ...unboundMentionAgents].map((agent) => [agent.id, agent]),
  )
  const channelAgents: ChannelAgent[] = channel.agentBindings.map((binding) => ({
    id: binding.agent.id,
    name: binding.agent.name,
    ...(binding.principalUserId ? { principalUserId: binding.principalUserId } : {}),
    role: binding.agent.role,
    systemPrompt: binding.agent.systemPrompt,
  }))
  const resolvedChannelAgents = channel.systemChannelType === 'personal_assistant'
    ? channelAgents.slice(0, 1) : channelAgents
  const mentionedAgentIds = agentMentions.length > 0
    ? ordinaryMentionIds
    : mentionedAgentIdsFromContent(input.content,
      resolvedChannelAgents.filter((agent) => agent.principalUserId === undefined))
  if (channel.adminOnlyPosting && mentionedAgentIds.length > 0) {
    throw new ChannelPostForbiddenError('Agents cannot reply in a read-only channel')
  }
  return { kind: 'valid', agentMentions, ordinaryMentionIds, boundOrdinaryIds,
    structuredOrdinaryAgents, channelAgents: resolvedChannelAgents, mentionedAgentIds }
}

/** An unbound agent mention offers an invite after the human post commits. */
export const findPendingAgentInvites = async (
  prisma: PrismaClient,
  input: { channel: AgentMentionChannel; content: string; userId: string;
    resolved: ResolvedAgentMentions },
): Promise<Array<{ id: string; name: string }>> => {
  const { channel, resolved } = input
  const pending: Array<{ id: string; name: string }> = []
  if (resolved.agentMentions.length > 0) {
    for (const agentId of resolved.ordinaryMentionIds) {
      if (resolved.boundOrdinaryIds.has(agentId)) continue
      const agent = resolved.structuredOrdinaryAgents.get(agentId)
      if (agent) pending.push(agent)
    }
  } else if (input.content.includes('@')) {
    const boundIds = new Set(resolved.channelAgents.map((agent) => agent.id))
    const candidates = await prisma.agent.findMany({
      where: {
        AND: [buildAgentVisibilityWhere({
          organizationId: channel.organizationId, userId: input.userId,
        })],
        agentKind: 'shared', executionMode: { not: 'external_mcp' },
        id: { notIn: [...boundIds] }, organizationId: channel.organizationId,
      },
      select: { id: true, name: true },
    })
    for (const agent of candidates) {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const mentionRe = new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i')
      if (mentionRe.test(input.content)) pending.push({ id: agent.id, name: agent.name })
    }
  }
  return pending
}
