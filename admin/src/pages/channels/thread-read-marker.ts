export const shouldMarkThreadRead = (input: {
  enabled: boolean
  lastReadMarker: string | null
  latestMessageId: string | undefined
  pendingReadMarker: string | null
  threadId: string | undefined
}): string | null => {
  if (!input.enabled || !input.threadId || !input.latestMessageId) {
    return null
  }
  const marker = `${input.threadId}:${input.latestMessageId}`
  return input.lastReadMarker === marker || input.pendingReadMarker === marker
    ? null
    : marker
}

// A reply conversation is not visible until both its root and reply list have
// resolved. Marking from the root alone would let the server advance the
// cursor past replies that are still loading in the panel.
export const isConversationReadReady = (input: {
  isReplyConversation: boolean
  repliesLoaded: boolean
  rootLoaded: boolean
}): boolean => !input.isReplyConversation || (input.rootLoaded && input.repliesLoaded)
