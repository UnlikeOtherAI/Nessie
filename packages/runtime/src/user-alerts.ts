import type { PrismaClient } from '@prisma/client'

// ─── mention resolution ──────────────────────────────────────────────────────
// Shared by the api (human-authored messages) and the worker (agent-authored
// messages) so @mention resolution is identical on every create path.

export type MessageMentions = {
  userIds: string[]
  agentIds: string[]
  broadcast: 'here' | 'channel' | 'everyone' | null
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Matches a @name token, allowing the name itself to contain spaces (members
// and agents can have multi-word display names). Same boundary rule the agent
// orchestrator uses, so resolution is identical on both sides.
const mentionMatches = (content: string, name: string): boolean => {
  if (!name) return false
  const re = new RegExp(`@${escapeRegExp(name)}(?:\\s|$|[^\\w])`, 'i')
  return re.test(content)
}

export const resolveMessageMentions = (
  content: string,
  input: { members: Array<{ userId: string; displayName: string }> },
): MessageMentions => {
  const userIds: string[] = []
  let broadcast: MessageMentions['broadcast'] = null

  if (content.includes('@')) {
    for (const member of input.members) {
      if (mentionMatches(content, member.displayName)) {
        userIds.push(member.userId)
      }
    }
    // Literal broadcast tokens. `@everyone` wins over `@channel` over `@here`
    // if multiple are present, mirroring Slack's escalation order.
    if (/@everyone(?:\s|$|[^\w])/i.test(content)) {
      broadcast = 'everyone'
    } else if (/@channel(?:\s|$|[^\w])/i.test(content)) {
      broadcast = 'channel'
    } else if (/@here(?:\s|$|[^\w])/i.test(content)) {
      broadcast = 'here'
    }
  }

  return { userIds: [...new Set(userIds)], agentIds: [], broadcast }
}

export const mentionedAgentIdsFromContent = (
  content: string,
  agents: Array<{ id: string; name: string }>,
): string[] => {
  if (!content.includes('@')) return []
  const ids = agents.filter((a) => mentionMatches(content, a.name)).map((a) => a.id)
  return [...new Set(ids)]
}

// ─── mention alert persistence ───────────────────────────────────────────────
// One `mention` UserAlert row per directly @mentioned user. Self-mentions are
// skipped; broadcast mentions intentionally create no rows (they would be
// noise at scale — push framing covers them). Agent-authored mentions create
// alerts identically (`actorAgentId` set instead of / alongside `actorUserId`).
// Muted channels still get rows: mute suppresses the push, never the alert.

export type MentionUserAlertInput = {
  organizationId: string
  messageId: string
  threadId: string
  channelId: string
  actorUserId?: string | null
  actorAgentId?: string | null
  mentionedUserIds: string[]
}

/**
 * Writes the mention alert rows and returns the alerted recipient user ids so
 * the caller can fan out `alert.created` realtime events. Safe to call inside
 * the message-create transaction (accepts a transaction client).
 */
export const createMentionUserAlerts = async (
  prisma: Pick<PrismaClient, 'userAlert'>,
  input: MentionUserAlertInput,
): Promise<string[]> => {
  const recipientIds = [...new Set(input.mentionedUserIds)].filter(
    (userId) => userId !== input.actorUserId,
  )
  if (recipientIds.length === 0) {
    return []
  }

  await prisma.userAlert.createMany({
    data: recipientIds.map((userId) => ({
      organizationId: input.organizationId,
      userId,
      kind: 'mention' as const,
      messageId: input.messageId,
      threadId: input.threadId,
      channelId: input.channelId,
      actorUserId: input.actorUserId ?? null,
      actorAgentId: input.actorAgentId ?? null,
    })),
  })

  return recipientIds
}
