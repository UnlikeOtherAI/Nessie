import { createContext, useContext } from 'react'
import type { ThreadMessageRecord } from '../../../lib/api-client'

/**
 * An earlier message as the feed a link sits in has it: who wrote it and the
 * start of what they said. Empty `excerpt` when the reader may not read it.
 */
export type FeedMessageRef = { authorName: string; excerpt: string }

/**
 * How a message in a feed reaches another message it points at — a one-on-one
 * reply's link back to the earlier message it is about (`metadata.messageRef`).
 * The feed rendering the link is the one that knows what it has loaded and
 * where a message sits in it, so it answers both questions; a surface that
 * cannot scroll to a message (a drawer, a reply panel) gives no `jumpTo`.
 */
export type FeedMessageRefs = {
  /** The message as this feed has it, or null when it has not loaded it. */
  find: (messageId: string) => FeedMessageRef | null
  /** Scroll the feed to the message and flash it. */
  jumpTo?: (messageId: string) => void
}

export const FeedMessageRefsContext = createContext<FeedMessageRefs | null>(null)

export const useFeedMessageRefs = (): FeedMessageRefs | null => useContext(FeedMessageRefsContext)

const EXCERPT_LENGTH = 140

/**
 * The answers a feed gives, from the messages it has loaded. A deleted message
 * is not there to go to; a withheld one is named but not quoted.
 */
export const buildFeedMessageRefs = (
  messages: readonly ThreadMessageRecord[],
  options: {
    agentName: (agentId: string) => string
    jumpTo?: (messageId: string) => void
    meUserId: string
  },
): FeedMessageRefs => {
  const loaded = new Map(messages
    .filter((message) => !message.deletedAt)
    .map((message) => [message.id, message] as const))
  return {
    find: (messageId) => {
      const message = loaded.get(messageId)
      if (!message) return null
      const flat = message.restricted ? '' : message.content.replace(/\s+/g, ' ').trim()
      return {
        authorName: message.role === 'assistant' && message.agentId
          ? options.agentName(message.agentId)
          : message.userId === options.meUserId
            ? 'You'
            : message.author?.displayName ?? 'Someone',
        excerpt: flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH)}…`,
      }
    },
    ...(options.jumpTo ? { jumpTo: options.jumpTo } : {}),
  }
}
