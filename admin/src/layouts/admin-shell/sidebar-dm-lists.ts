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
): SidebarPerson[] =>
  peopleDirectory.filter((person) => {
    const channel = person.dmChannelId
      ? channels.find((candidate) => candidate.id === person.dmChannelId)
      : undefined
    return Boolean(channel && isStartedConversation(channel, currentChannelId))
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
