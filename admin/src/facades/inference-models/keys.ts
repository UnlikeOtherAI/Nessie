// Deployment model-catalogue cache keys. The rules every keys.ts answers to — a
// family root that prefixes its members, and no key spelled as a literal at a
// call site — are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const inferenceModelKeys = {
  all: ['inference-models'] as const,
  // The paged Ledger catalogue with this organisation's decisions folded in.
  // `usePagedList` appends the page identity through `paginationKeys.page`, so
  // a toggle invalidating the root reaches every page of it.
  catalog: ['inference-models', 'catalog'] as const,
}
