import { useMemo } from 'react'
import type {
  AgentRecord,
  MessageReaction,
  PersonalAssistantPresenceParticipant,
  UserRecord,
} from '../../../lib/api-client'
import type { FeedItem } from './channel-helpers'
import { personalAssistantPresenceKey } from './personal-assistant-presence'
import type { ResolveReactorName } from './ReactionPills'

type Args = {
  agentById: Map<string, AgentRecord>
  agentMap: Map<string, AgentRecord>
  assistantFallbackName: string
  channelUsers: UserRecord[] | undefined
  feedItems: FeedItem[]
  meUserId: string
  personalAssistantPresenceByIdentity: Map<string, PersonalAssistantPresenceParticipant>
}

export const useResolveReactorName = ({
  agentById,
  agentMap,
  assistantFallbackName,
  channelUsers,
  feedItems,
  meUserId,
  personalAssistantPresenceByIdentity,
}: Args): ResolveReactorName => useMemo(() => {
  const userNames = new Map<string, string>()
  for (const user of channelUsers ?? []) {
    userNames.set(user.id, user.displayName)
  }
  for (const item of feedItems) {
    if (item.kind === 'message' && item.message.userId && item.message.author?.displayName) {
      userNames.set(item.message.userId, item.message.author.displayName)
    }
  }
  return (reaction: MessageReaction): string => {
    if (reaction.userId) {
      return reaction.userId === meUserId ? 'You' : userNames.get(reaction.userId) ?? 'Someone'
    }
    if (reaction.agentId) {
      const presence = reaction.onBehalfOfUserId
        ? personalAssistantPresenceByIdentity.get(personalAssistantPresenceKey(
            reaction.agentId,
            reaction.onBehalfOfUserId,
          ))
        : undefined
      if (presence) return presence.displayName
      return agentMap.get(reaction.agentId)?.name
        ?? agentById.get(reaction.agentId)?.name
        ?? assistantFallbackName
    }
    return 'Someone'
  }
}, [
  agentById,
  agentMap,
  assistantFallbackName,
  channelUsers,
  feedItems,
  meUserId,
  personalAssistantPresenceByIdentity,
])
