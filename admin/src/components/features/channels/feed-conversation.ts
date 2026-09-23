import { createContext, useContext } from 'react'

/**
 * The conversation a message feed shows. A message record names its thread
 * and its reply-thread root, not its conversation, and one feed renders in a
 * conversation, a reply panel, a Threads inbox card and the person and agent
 * drawers — so a card that acts on its own message's place (an older DeepWater
 * card opening a new research brief) reads the conversation from the feed it
 * sits in, never from the screen behind it. Null while that surface has no
 * conversation yet.
 */
export type FeedConversation = { channelId: string }

export const FeedConversationContext = createContext<FeedConversation | null>(null)

export const useFeedConversation = (): FeedConversation | null => useContext(FeedConversationContext)
