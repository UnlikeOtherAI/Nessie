import type { PersonalAssistantPresenceParticipant } from '../../../lib/api-client'

export const personalAssistantPresenceKey = (
  agentId: string,
  principalUserId: string,
): string => `${agentId}:${principalUserId}`

export const indexPersonalAssistantPresences = (
  presences: PersonalAssistantPresenceParticipant[],
): Map<string, PersonalAssistantPresenceParticipant> => new Map(
  presences.map((presence) => [
    personalAssistantPresenceKey(presence.agentId, presence.principalUserId),
    presence,
  ]),
)
