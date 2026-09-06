// Channel cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const channelKeys = {
  all: ['channels'] as const,
  messageSearch: (channelId: string | undefined, query: string) =>
    ['channels', channelId, 'messages', 'search', query] as const,
}
