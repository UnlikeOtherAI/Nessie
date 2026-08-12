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
