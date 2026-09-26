// Audit trail cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const auditLogKeys = {
  all: ['audit-log'] as const,
  /** The paged list; `usePagedList` appends the filters and the page. */
  entries: ['audit-log', 'entries'] as const,
  entry: (entryId: string) => ['audit-log', 'entry', entryId] as const,
  summary: (groupBy: string) => ['audit-log', 'summary', groupBy] as const,
  verification: ['audit-log', 'verification'] as const,
}
