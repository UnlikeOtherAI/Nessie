// Executor cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const executorKeys = {
  all: ['executors'] as const,
  detail: (executorId: string) => ['executors', executorId] as const,
  access: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'access'] as const,
  accessChange: (accessChangeId?: string) =>
    ['executors', 'access-change', accessChangeId ?? 'none'] as const,
  myWorkspaceReviews: ['executors', 'workspace-reviews', 'mine'] as const,
  pairing: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'pairing'] as const,
  workspacePromotion: (promotionId?: string) =>
    ['executors', 'workspace-promotion', promotionId ?? 'none'] as const,
  workspaceReviews: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'workspace-reviews'] as const,
}
