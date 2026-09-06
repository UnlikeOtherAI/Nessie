// Trigger cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const triggerKeys = {
  all: ['triggers'] as const,
  // An absent id keeps its slot rather than collapsing to a placeholder, so a
  // disabled render and an enabled one agree on cache identity.
  history: (triggerId: string | undefined, limit: number) =>
    ['triggers', triggerId, 'history', limit] as const,
}
