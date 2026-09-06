// App catalogue cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

const appsRoot = ['apps'] as const

export const appKeys = {
  all: appsRoot,
  // "Show all" walks one shelf's own pages — a category, or the flat Installed
  // list, which has no category and keys on null. A different corpus from the
  // mixed catalogue slice `list` holds, under the same root, so a single
  // invalidation after a connect or disconnect still reaches both.
  shelf: (category: string | null, installed: boolean) =>
    [...appsRoot, 'shelf', category, installed] as const,
  detail: (slug?: string) => [...appsRoot, 'detail', slug ?? null] as const,
  // The facade normalises before it calls this, so each field is spelled one
  // way by the time it reaches the key. The defaults restate that normal form
  // rather than inventing a second one: an absent query is the empty search,
  // an absent `installed` is the unnarrowed catalogue, an absent offset is the
  // first page.
  list: (filters: {
    category?: string
    installed?: boolean
    offset?: number
    query?: string
  }) =>
    [
      ...appsRoot,
      'list',
      filters.query ?? '',
      filters.category ?? null,
      filters.installed === true,
      filters.offset ?? 0,
    ] as const,
}
