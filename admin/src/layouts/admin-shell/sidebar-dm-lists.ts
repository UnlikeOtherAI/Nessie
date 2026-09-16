import {
  isExternalAgentChannel,
  isGlobalAgentChannel,
  isPersonalAssistantChannel,
  isUserDmChannel,
} from '../../facades/personal-assistant/channel-kinds'
import type { AgentRecord, ChannelRecord, MeResponse, UserRecord } from '../../lib/api-client'
import type { SidebarAgentDm, SidebarPerson } from './types'

/**
 * Direct messages lists conversations, not a directory. Every DM channel here
 * is provisioned before anybody speaks — a person's DM the first time either
 * side opens it, a private agent's home DM with the agent, a global agent's
 * (the Agent Designer's) home DM with the account itself — so a section that
 * listed provisioned channels was a roster of the team rather than of who
 * the viewer talks to. A row appears once a message exists, and the channel the
 * viewer is standing in stays listed so opening a fresh conversation never
 * makes its own row vanish underneath them.
 */
export const isStartedConversation = (
  channel: ChannelRecord,
  currentChannelId?: string,
): boolean => Boolean(channel.lastMessageAt) || channel.id === currentChannelId

/**
 * How long a person's DM row outlives the last thing said in it.
 *
 * The second half of "lists conversations, not a directory": a conversation
 * nobody has touched in a fortnight is not one the viewer is having, and a
 * list of everyone they have *ever* messaged is the roster again, one year
 * later. Fourteen days is the product decision, not a derived number.
 */
export const DM_QUIET_DAYS = 14

const DM_QUIET_WINDOW_MS = DM_QUIET_DAYS * 24 * 60 * 60 * 1000

type PersonDmVisibility = {
  /** The channel on screen, which never disappears under the reader. */
  currentChannelId?: string
  /** Injected so the rule is testable; the shell passes nothing and gets now. */
  now?: number
}

/**
 * Whether a person's DM still belongs in Direct messages.
 *
 * Only the *row* goes when it ages out. The channel, its whole history and its
 * URL are untouched, and messaging that person again — the section's `+`, a
 * project's member row, any surface that calls `useNavigateToDm` — resolves
 * that same DM server-side (`POST /api/dm/:userId`) and brings the row back
 * with everything in it. Nothing is archived and nothing is deleted.
 *
 * Two facts outrank the window, both because hiding the row would cost the
 * reader something rather than tidy anything:
 * - the channel they are standing in, exactly as `isStartedConversation` keeps
 *   a brand-new DM listed before its first message;
 * - a DM holding messages they have not read — a quiet fortnight is not
 *   permission to hide an unread message.
 *
 * Starring is unaffected either way: a starred person renders in Starred and
 * is skipped here (`SidebarDmSection`), so an explicit "keep this" never
 * depends on recency.
 *
 * Agent DMs deliberately keep the plain `isStartedConversation` rule. Their
 * recency would have to be honest first: `ChannelRecord.lastMessageAt` is the
 * channel's *default thread* only, so an agent DM busy with conversations
 * (`docs/plans/2026-09-08-agent-conversations.md` → Later, "`Channel.lastMessageAt`
 * across threads") reads as silent, and ageing it out on that number would
 * hide a room in daily use.
 */
export const isListedPersonDm = (
  channel: ChannelRecord,
  { currentChannelId, now = Date.now() }: PersonDmVisibility = {},
): boolean => {
  if (channel.id === currentChannelId) return true
  if (channel.unreadCount > 0) return true

  const lastMessageAt = channel.lastMessageAt ? Date.parse(channel.lastMessageAt) : Number.NaN
  // A DM nobody has said anything in has no age to be inside the window, which
  // is the "a row appears once a message exists" half of the rule.
  return Number.isFinite(lastMessageAt) && now - lastMessageAt < DM_QUIET_WINDOW_MS
}

/**
 * Every person the viewer could hold a DM with, resolved to their DM channel
 * when one exists. It backs the starred lookup — starring somebody IS adding
 * them — and is deliberately not the Direct-messages list.
 */
export const resolvePeopleDirectory = (
  me: MeResponse | null,
  users: UserRecord[],
  channels: ChannelRecord[],
): SidebarPerson[] => {
  if (!me) return []

  const currentUser = users.find((user) => user.id === me.user.id)
  const people = [
    {
      id: me.user.id,
      label: me.user.displayName,
      avatarUrl: currentUser?.avatarUrl ?? me.user.avatarUrl ?? null,
      avatarAttachmentId: currentUser?.avatarAttachmentId ?? me.user.avatarAttachmentId ?? null,
    },
    ...users
      .filter((user) => user.id !== me.user.id)
      .map((user) => ({
        id: user.id,
        label: user.displayName,
        avatarUrl: user.avatarUrl,
        avatarAttachmentId: user.avatarAttachmentId,
      })),
  ]

  return people.map((person) => ({
    ...person,
    // `dmUserId` is the counterpart the server resolved for this viewer, so it
    // names the person's DM directly instead of intersecting channel-id lists.
    dmChannelId: channels.find(
      (channel) => isUserDmChannel(channel) && channel.dmUserId === person.id,
    )?.id,
  }))
}

export const resolvePeopleWithConversations = (
  peopleDirectory: SidebarPerson[],
  channels: ChannelRecord[],
  currentChannelId?: string,
  now?: number,
): SidebarPerson[] =>
  peopleDirectory.filter((person) => {
    const channel = person.dmChannelId
      ? channels.find((candidate) => candidate.id === person.dmChannelId)
      : undefined
    return Boolean(channel && isListedPersonDm(channel, {
      ...(currentChannelId === undefined ? {} : { currentChannelId }),
      ...(now === undefined ? {} : { now }),
    }))
  })

type ResolveAgentDmsInput = {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  currentChannelId?: string
  pinnedChannelIds: Set<string>
  systemAgents: AgentRecord[]
}

export const resolveAgentDms = ({
  agents,
  channels,
  currentChannelId,
  pinnedChannelIds,
  systemAgents,
}: ResolveAgentDmsInput): SidebarAgentDm[] =>
  channels
    .filter((channel) => channel.type === 'dm' && !isPersonalAssistantChannel(channel))
    .filter((channel) => channel.isGroupDm !== true)
    .filter((channel) => isStartedConversation(channel, currentChannelId))
    // A channel pinned as a product assistant under the PA is never also
    // listed in the generic agent-DM list.
    .filter((channel) => !pinnedChannelIds.has(channel.id))
    .flatMap((channel): SidebarAgentDm[] => {
      const agent = agents.find((candidate) => candidate.channelIds.includes(channel.id))
      if (agent) {
        return [{ dmChannelId: channel.id, id: agent.id, agentId: agent.id, label: agent.name }]
      }
      // External agents (DeepSignal, ...) bind a system-managed `Agent` row
      // that the general agent list excludes, so it never resolves above —
      // fall back to the channel's own label, keyed by channel id.
      if (isExternalAgentChannel(channel)) {
        return [{ dmChannelId: channel.id, id: channel.id, agentId: null, label: channel.label }]
      }
      // A global agent (the Agent Designer, ...) is system-managed too, so it
      // is absent from `agents` for the same reason — but it IS a real Nessie
      // agent with a picture, so it resolves through the system tier and keeps
      // its agent id for the identity directory.
      if (isGlobalAgentChannel(channel)) {
        const globalAgent = systemAgents.find((candidate) =>
          candidate.channelIds.includes(channel.id),
        )
        return [{
          dmChannelId: channel.id,
          id: globalAgent?.id ?? channel.id,
          agentId: globalAgent?.id ?? null,
          label: globalAgent?.name ?? channel.label,
        }]
      }
      return []
    })
