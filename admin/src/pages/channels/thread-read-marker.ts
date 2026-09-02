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
//
// `messagesArePlaceholder` is the sibling-swap case: the thread queries keep
// the previous conversation on screen while the new one loads
// (docs/navigation/overview.md §"Arriving with content"), so for one render `threadId`
// is the new thread while the newest message id still belongs to the old one.
// Acknowledging that pair would advance the new thread's cursor to a message
// it has never held. `isSuccess` cannot answer this: a query serving
// placeholder data reports success.
export const isConversationReadReady = (input: {
  isReplyConversation: boolean
  messagesArePlaceholder: boolean
  repliesLoaded: boolean
  rootLoaded: boolean
}): boolean => {
  if (input.messagesArePlaceholder) return false
  return !input.isReplyConversation || (input.rootLoaded && input.repliesLoaded)
}
