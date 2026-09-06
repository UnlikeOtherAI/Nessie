import type { AgentIdentity } from '../../../shared/agent-identity'

/** A reply, as the channel feed sees it: who wrote one, and where a copy of
 * one landed. */

// "Also send to #channel" copies land in the channel feed as top-level
// messages tagged with metadata.replyBroadcast = { rootMessageId }.
export const getReplyBroadcastRootId = (
  metadata: Record<string, unknown> | undefined,
): string | null => {
  const broadcast = metadata?.replyBroadcast
  if (!broadcast || typeof broadcast !== 'object' || Array.isArray(broadcast)) {
    return null
  }
  const rootMessageId = (broadcast as Record<string, unknown>).rootMessageId
  return typeof rootMessageId === 'string' && rootMessageId.length > 0 ? rootMessageId : null
}

// One avatar entry in a reply summary bar, resolved from a participant id
// against the channel's users and agents.
export type ThreadParticipant =
  | {
      kind: 'user'
      userId: string
      avatarAttachmentId?: string | null
      avatarUrl?: string | null
      displayName: string
    }
  // Identity, not the entitled record: the summary bar only draws a picture,
  // and a system-managed agent that replied is resolved through the agent
  // identity directory rather than the channel's agent list.
  | { kind: 'agent'; agent: AgentIdentity }
