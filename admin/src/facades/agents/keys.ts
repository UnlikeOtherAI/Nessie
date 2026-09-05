// Agent cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const agentKeys = {
  all: ['agents'] as const,
  pausedPrivateCount: ['agents', 'paused-private-count'] as const,
  // The org-wide list is a different corpus from the caller's own agents, and
  // both live under the family root so one invalidation covers them.
  allScopes: ['agents', 'all'] as const,
  activity: (agentId?: string) => ['agents', agentId, 'activity'] as const,
  children: (agentId?: string) => ['agents', agentId, 'children'] as const,
  documents: (agentId?: string) => ['agents', agentId, 'documents'] as const,
  messages: (agentId: string) => ['agents', agentId, 'messages'] as const,
  messagePage: (agentId: string | undefined, limit: number, offset: number) =>
    ['agents', agentId, 'messages', limit, offset] as const,
  models: ['agents', 'models'] as const,
  runTools: (agentId?: string, runId?: string) =>
    ['agents', agentId, 'runs', runId, 'tools'] as const,
  status: (agentId?: string) => ['agents', agentId, 'status'] as const,
  // An absent id keeps its slot rather than collapsing to a placeholder, so a
  // disabled render and an enabled one agree on cache identity.
  triggers: (agentId?: string) => ['agents', agentId, 'triggers'] as const,
  // Live run state. Deliberately a child of the trigger-list key: it holds its
  // own fast refetch cadence while something is running, and every existing
  // invalidation of the list already reaches it, so firing or pausing a
  // trigger refreshes what the row says it is doing.
  triggerActivity: (agentId?: string) => ['agents', agentId, 'triggers', 'activity'] as const,
}
