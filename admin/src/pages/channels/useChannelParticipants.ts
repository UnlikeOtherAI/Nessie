import { useMemo } from 'react'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../lib/api-client'
import { mentionableUsers } from '../../components/features/channels/mention-invite'

export const useChannelParticipants = (
  activeChannel: ChannelRecord | null,
  agents: AgentRecord[],
  users: UserRecord[],
) => {
  const boundAgents = useMemo(
    () => activeChannel
      ? agents.filter((agent) => agent.channelIds.includes(activeChannel.id))
      : [],
    [activeChannel, agents],
  )
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const channelUsers = useMemo(
    () => activeChannel
      ? users.filter((user) => user.channelIds.includes(activeChannel.id))
      : [],
    [activeChannel, users],
  )
  // Who the composer can @mention: every active person in the organisation,
  // not only the room's participants. Somebody who cannot read the room is
  // asked about before the send (`useMentionInviteGate`).
  const mentionUsers = useMemo(() => mentionableUsers(users), [users])
  return { agentMap, boundAgents, channelUsers, mentionUsers }
}
