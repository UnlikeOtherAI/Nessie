/** Structural facts that prove a stored row is a raw human turn. */
export type RawHumanMessage = {
  agentId: string | null
  metadata: unknown
  onBehalfOfUserId: string | null
  role: string
  userId: string | null
}

const hasDelegatedAgentMetadata = (metadata: unknown): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (
    'delegatedByAgentId' in metadata
    || 'delegatedFromRunId' in metadata
  )

/**
 * `userId` may record the effective person for an agent-delivered action.
 * Original-author disclosure requires the narrower proof of a raw human turn.
 */
export const originalHumanAuthorId = (message: RawHumanMessage): string | null => {
  if (
    message.role !== 'user'
    || message.agentId !== null
    || message.onBehalfOfUserId !== null
    || hasDelegatedAgentMetadata(message.metadata)
  ) return null
  return message.userId
}
