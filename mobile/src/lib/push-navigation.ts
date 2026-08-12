export type PushData = Record<string, unknown>

/**
 * Returns an internal Nessie path only. Native notification data is untrusted,
 * so it can never make the WebView open another origin.
 */
export const pathFromPushData = (data: PushData): string | null => {
  if (typeof data.url === 'string' && data.url.startsWith('/')) {
    return data.url
  }
  if (typeof data.channelId !== 'string' || data.channelId.length === 0) {
    return null
  }

  const path = `/channels/${encodeURIComponent(data.channelId)}`
  return typeof data.messageId === 'string' && data.messageId.length > 0
    ? `${path}?messageId=${encodeURIComponent(data.messageId)}`
    : path
}
