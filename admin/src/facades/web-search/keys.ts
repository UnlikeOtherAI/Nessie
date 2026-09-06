// Web search cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const webSearchKeys = {
  all: ['web-search'] as const,
  /**
   * One entry per page of one query, so paging back to a page already read is
   * instant and costs nothing — a second Ledger-metered search for a page the
   * reader has already seen would be spending money to redraw a screen.
   */
  page: (query: string, page: number, count: number) =>
    [...webSearchKeys.all, query, page, count] as const,
}
