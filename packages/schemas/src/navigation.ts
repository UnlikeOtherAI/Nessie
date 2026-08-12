/**
 * The canonical route for opening a channel message's conversation. A reply
 * always opens at its root; a top-level message is its own root.
 */
export const buildChannelMessagePath = (input: {
  channelId: string
  messageId: string
  rootMessageId?: string | null
  threadId: string
}): string =>
  `/channels/${input.channelId}/threads/${input.threadId}/replies/${
    input.rootMessageId ?? input.messageId
  }`
