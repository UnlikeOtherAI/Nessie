// Billing cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

/**
 * Roots only. The scoped keys are built in the billing facade, which owns the
 * UOA capability scope that has to be part of cache identity — one team's
 * manager projection must never be reused after an active-team switch.
 */
export const billingKeys = {
  capability: ['uoa-billing-capability'] as const,
  credits: ['uoa-billing-credits'] as const,
  recurringAddons: ['uoa-billing-recurring-addons'] as const,
  statement: ['uoa-billing-statement'] as const,
}
