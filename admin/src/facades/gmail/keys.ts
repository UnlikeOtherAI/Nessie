// Gmail draft cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const gmailKeys = {
  all: ['gmail'] as const,
  draft: (id: string) => ['gmail', 'draft', id] as const,
  draftStatus: (id: string) => ['gmail', 'draft-status', id] as const,
  sendGrants: ['gmail', 'send-grants'] as const,
}
