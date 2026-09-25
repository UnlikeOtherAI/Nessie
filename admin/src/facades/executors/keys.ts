// Executor cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const executorKeys = {
  all: ['executors'] as const,
  project: (projectId: string) => ['executors', 'project', projectId] as const,
  sharing: (executorId: string, teamId?: string) => ['executors', executorId, 'sharing', teamId ?? 'none'] as const,
  attention: ['executors', 'attention'] as const,
  detail: (executorId: string) => ['executors', executorId] as const,
  access: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'access'] as const,
  accessChange: (accessChangeId?: string) =>
    ['executors', 'access-change', accessChangeId ?? 'none'] as const,
  agents: (executorId: string) => ['executors', executorId, 'agents'] as const,
  /** The coding sessions open on one machine, for its administrators. */
  codingSessions: (executorId: string) => ['executors', executorId, 'coding-sessions'] as const,
  sessionView: (executorId: string, sessionId: string) => ['executors', executorId, 'session-view', sessionId] as const,
  /** The host sessions the viewer may open, on one machine or on every one. */
  hostSessions: (executorId?: string) => ['executors', 'host-sessions', executorId ?? 'all'] as const,
  /** Who a session's owner shared its view with. */
  sessionShares: (executorId: string, sessionId: string) =>
    ['executors', executorId, 'session', sessionId, 'shares'] as const,
  /** The viewer's own conversation leases in one thread (the composer indicator). */
  conversationLeases: (threadId?: string) =>
    ['executors', 'conversation-leases', threadId ?? 'none'] as const,
  /** Every live lease on one machine, for its administrators. */
  machineLeases: (executorId: string) => ['executors', executorId, 'leases'] as const,
  agentCandidates: (executorId: string) => ['executors', executorId, 'agent-candidates'] as const,
  myWorkspaceReviews: ['executors', 'workspace-reviews', 'mine'] as const,
  pairingOptions: ['executors', 'pairing-options'] as const,
  pairingStatus: (executorId: string | null) =>
    ['executors', executorId ?? 'none', 'pairing-status'] as const,
  pairing: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'pairing'] as const,
  workspacePromotion: (promotionId?: string) =>
    ['executors', 'workspace-promotion', promotionId ?? 'none'] as const,
  workspaceReviews: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'workspace-reviews'] as const,
}
