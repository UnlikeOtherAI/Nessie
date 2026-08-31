import { useMemo } from 'react'
import type { AgentRecord, ChannelRecord, UserRecord } from '../../lib/api-client'

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
  return { agentMap, boundAgents, channelUsers }
}
