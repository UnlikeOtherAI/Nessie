// External board source cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

/**
 * External board sources. The connection-side keys are their own family
 * (they are a person's accounts, not a project's), while a project's attached
 * sources nest under `projectKeys` so a project mutation reaches them.
 */
export const boardSourceKeys = {
  all: ['board-sources'] as const,
  providers: ['board-sources', 'providers'] as const,
  connections: ['board-sources', 'connections'] as const,
  containers: (connectionId?: string) =>
    ['board-sources', 'connections', connectionId ?? 'none', 'containers'] as const,
}
