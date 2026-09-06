// App connection request cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

/** Viewer-scoped, durable card state; the message itself contains only its id. */
export const appConnectionRequestKeys = {
  card: (requestId?: string) => ['app-connection-requests', requestId ?? null] as const,
}
