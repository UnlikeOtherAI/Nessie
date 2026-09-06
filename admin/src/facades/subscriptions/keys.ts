// Model-subscription cache keys. The rules every keys.ts answers to — a family
// root that prefixes its members, and no key spelled as a literal at a call
// site — are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

// The list is the family: one flat collection plus the catalogue of providers
// it can be extended from, so the root and the list key are the same array.
const subscriptionsRoot = ['model-subscriptions'] as const

export const subscriptionKeys = {
  all: subscriptionsRoot,
  list: subscriptionsRoot,
  providers: [...subscriptionsRoot, 'providers'] as const,
}
