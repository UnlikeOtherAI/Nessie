import type { AgentRecord, PersonalAssistantPresenceParticipant } from '../../../lib/api-client'

/** Who is in the conversation, as the rows and drawers project them. */

// The channel drawer accepts this union so a PA presence stays a participant
// projection instead of being coerced into the private AgentRecord surface.
export type ChannelAgentParticipant = AgentRecord | PersonalAssistantPresenceParticipant

export type MessageUserIdentity = {
  avatarAttachmentId?: string | null
  avatarUrl?: string | null
  displayName: string
  id: string
}
