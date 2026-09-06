// Search cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const searchKeys = {
  knowledge: (query: string, mode: string) =>
    ['search', 'knowledge', query, mode] as const,
  messages: (query: string, mode: string) =>
    ['search', 'messages', query, mode] as const,
  thoughts: (query: string, mode: string) =>
    ['search', 'thoughts', query, mode] as const,
}
