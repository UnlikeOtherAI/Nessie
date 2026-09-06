// Thread cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const threadKeys = {
  // The unread/activity projection across every thread. Read-marker writes
  // patch their one cached card; other activity changes reset this key because
  // they can move records across keyset page boundaries.
  activityRoot: ['threads', 'activity'] as const,
  activity: (unreadOnly = false) =>
    ['threads', 'activity', { unreadOnly }] as const,
  unreadDirectMessages: ['threads', 'unread-direct-messages'] as const,
  documentStream: (threadId: string | undefined, sessionId: string) =>
    ['threads', threadId, 'documentStreams', sessionId] as const,
  documentStreams: (threadId?: string) =>
    ['threads', threadId, 'documentStreams'] as const,
  message: (threadId?: string, messageId?: string) =>
    ['threads', threadId, 'message', messageId] as const,
  messages: (threadId?: string) => ['threads', threadId, 'messages'] as const,
  replies: (threadId?: string) => ['threads', threadId, 'replies'] as const,
  repliesOf: (threadId?: string, rootMessageId?: string) =>
    ['threads', threadId, 'replies', rootMessageId] as const,
  runThinking: (threadId: string | undefined, runId: string | null) =>
    ['threads', threadId, 'runs', runId, 'thinking'] as const,
}
