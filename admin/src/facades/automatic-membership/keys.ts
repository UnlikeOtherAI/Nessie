// Automatic team membership cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

// Automatic team access after sign-in. Scoped by surface, because the
// organisation and team reads return different subsets of the same shape.
export const automaticMembershipKeys = {
  all: ['automatic-membership'] as const,
  forScope: (scope: 'organization' | 'team') => ['automatic-membership', scope] as const,
}
