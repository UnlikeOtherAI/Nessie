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

// ─── mention audience ────────────────────────────────────────────────────────
// Who an @name in a channel can address. A channel member always can. In an
// *open* channel — public, not a DM, not a system conversation — every active
// organisation member already reads the room, so every active member is
// addressable too. In a private or protected channel a non-member is not: the
// author is asked to invite them before sending (the admin composer), and a
// send without inviting must not hand them an alert, a push, or a snippet.
// Only people with an `OrganizationMember` row (they accepted their invitation
// and have a Nessie principal) can ever be addressed; deactivated ones never.

export type MentionAudienceChannel = {
  organizationId: string
  systemChannelType?: string | null
  type?: string | null
  visibility?: string | null
}

export type MentionCandidate = { userId: string; displayName: string }

export const isOpenMentionChannel = (channel: MentionAudienceChannel): boolean =>
  channel.visibility === 'public' && channel.type !== 'dm' && !channel.systemChannelType

/**
 * The active organisation members an open channel adds to its mention
 * candidates; nobody for any other channel, whose candidates stay its members.
 */
export const listOpenChannelMentionCandidates = async (
  prisma: Pick<PrismaClient, 'organizationMember'>,
  channel: MentionAudienceChannel,
): Promise<MentionCandidate[]> => {
  if (!isOpenMentionChannel(channel)) return []
  const rows = await prisma.organizationMember.findMany({
    where: { organizationId: channel.organizationId, deactivatedAt: null },
    select: { user: { select: { id: true, displayName: true } } },
  })
  return rows.map((row) => ({ userId: row.user.id, displayName: row.user.displayName }))
}

export const mergeMentionCandidates = (
  ...lists: MentionCandidate[][]
): MentionCandidate[] => [
  ...new Map(lists.flat().map((candidate) => [candidate.userId, candidate])).values(),
]

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
  /** Stable source generation for callers whose work may be replayed. */
  eventKey?: string
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
      ...(input.eventKey ? { eventKey: input.eventKey } : {}),
    })),
    skipDuplicates: input.eventKey !== undefined,
  })

  return recipientIds
}

// ─── approval alerts ─────────────────────────────────────────────────────────
// Shared by the api (approvals opened by a route or a paired MCP agent) and the
// worker (approvals opened by an agent's own tools) so one decision rings one
// bell, however it was raised.

export type ApprovalUserAlertInput = {
  approvalId: string
  channelId?: string | null
  organizationId: string
  /** The agent that asked, when one did. Null for a paired-credential request. */
  actorAgentId?: string | null
  /** Exactly this person must answer. Set for a send-as-you or credential gate. */
  requiredApproverUserId?: string | null
  /** Anyone holding this organisation role may answer. */
  requiredApproverRole?: string | null
}

/**
 * Ring the people who can actually answer an approval, and nobody else.
 *
 * The audience is the gate's own audience, not the approval's readership:
 *
 * - Pinned to a person, and only that person is alerted. `approvalVisibilityWhere`
 *   shows a pinned approval to that person **alone** — not to owners, not to the
 *   channel — so anybody else would be told a decision exists that they cannot
 *   open. That is a leak, not a notification.
 * - Routed to a role, and the live holders of that role are alerted. Read fresh
 *   rather than taken on trust, and deactivated members are skipped: an alert to
 *   somebody who will be refused at the resolve is worse than no alert.
 * - Neither, and nobody is alerted. The audience there is "anyone who can read
 *   the channel", which is what the in-channel card is already for.
 *
 * The row carries ids only. What is waiting for approval reaches a lock screen
 * through the alert presenter, so the reason and context deliberately stay in
 * the approval, behind the entitlement-scoped read.
 *
 * `eventKey` is the same generation key the suspended-run path uses, so the two
 * writers can never raise two bells for one decision.
 *
 * Safe inside a transaction: takes a transaction client.
 */
export const createApprovalUserAlerts = async (
  prisma: Pick<PrismaClient, 'organizationMember' | 'userAlert'>,
  input: ApprovalUserAlertInput,
): Promise<string[]> => {
  const recipients = input.requiredApproverUserId
    ? [input.requiredApproverUserId]
    : input.requiredApproverRole
      ? (await prisma.organizationMember.findMany({
        select: { userId: true },
        where: {
          deactivatedAt: null,
          organizationId: input.organizationId,
          role: input.requiredApproverRole as never,
        },
      })).map((member) => member.userId)
      : []

  if (recipients.length === 0) return []

  await prisma.userAlert.createMany({
    data: recipients.map((userId) => ({
      actorAgentId: input.actorAgentId ?? null,
      approvalRequestId: input.approvalId,
      channelId: input.channelId ?? null,
      eventKey: `approval:${input.approvalId}`,
      kind: 'approval_requested' as const,
      organizationId: input.organizationId,
      userId,
    })),
    // A retry of the same creation must not double-ring.
    skipDuplicates: true,
  })

  return recipients
}
