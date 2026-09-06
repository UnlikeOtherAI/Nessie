// Comms connection cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const commsKeys = {
  connections: ['comms', 'connections'] as const,
  connection: (id: string) => ['comms', 'connections', id] as const,
  providers: ['comms', 'providers'] as const,
}
