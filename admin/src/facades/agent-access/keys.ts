// Agent-access cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const agentAccessKeys = {
  all: ['agent-access'] as const,
  credentials: ['agent-access', 'credentials'] as const,
  // The pending lookup is per pairing code, and the root above is what a
  // decision invalidates — so a code's own entry sits under it rather than
  // beside it.
  pending: (code: string) => ['agent-access', 'pending', code] as const,
  pendingAll: ['agent-access', 'pending'] as const,
}
