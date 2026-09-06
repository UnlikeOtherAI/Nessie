// Hosted agent-mailbox cache keys. The rules every keys.ts answers to — a
// family root that prefixes its members, and no key spelled as a literal at a
// call site — are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const agentMailboxKeys = {
  all: ['agent-email'] as const,
  config: () => ['agent-email', 'config'] as const,
  conversation: (agentId: string | undefined, conversationId: string | undefined) =>
    ['agent-email', 'conversation', agentId, conversationId] as const,
  conversations: (agentId: string | undefined, filter: string, cursor?: string) =>
    ['agent-email', 'conversations', agentId, filter, cursor ?? null] as const,
  draft: (approvalId: string | undefined) => ['agent-email', 'draft', approvalId] as const,
  mailbox: (agentId: string | undefined) => ['agent-email', 'mailbox', agentId] as const,
}
