// Session cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const authKeys = {
  // The session's own `/api/auth/me`, polled by `useSessionMe`. Deliberately
  // not `['auth', 'me']`: that is a prefix of `myAvatarRevision`, so the two
  // would invalidate each other and the client-only revision counter would be
  // reset by every poll.
  me: ['auth', 'session-me'] as const,
  myAvatarRevision: ['auth', 'me', 'avatar', 'revision'] as const,
  providers: ['auth', 'providers'] as const,
  sessions: ['auth', 'sessions'] as const,
}
