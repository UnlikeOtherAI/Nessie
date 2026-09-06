// Approval cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const approvalKeys = {
  all: ['approvals'] as const,
  detail: (approvalId?: string) => ['approvals', approvalId ?? null] as const,
  mailSendDraft: (toolName: 'gmail_draft_send' | 'mailbox_send', approvalId?: string) =>
    ['approvals', approvalId ?? null, 'mail-send-draft', toolName] as const,
  pendingCount: ['approvals', 'pending-count'] as const,
}
