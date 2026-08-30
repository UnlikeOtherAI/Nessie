import type { ThreadMessageRecord } from '../../lib/api-client'

const RECENT_REPLY_COUNT = 3

export const splitThreadInboxMessages = (
  root: ThreadMessageRecord | undefined,
  replies: ThreadMessageRecord[],
) => ({
  root: root ? [root] : [],
  recentReplies: replies.slice(-RECENT_REPLY_COUNT),
  hiddenReplyCount: Math.max(0, replies.length - RECENT_REPLY_COUNT),
})
