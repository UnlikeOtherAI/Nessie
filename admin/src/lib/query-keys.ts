/**
 * The two rules every query key in the admin answers to, and the one key
 * factory that belongs to no domain.
 *
 * Keys are cache identity, and React Query matches them by prefix. Two rules
 * follow, and they are checkable rather than remembered:
 *
 * 1. A family's root is the prefix of every key beneath it, so invalidating the
 *    root reaches the whole family.
 * 2. A sub-resource nests under its parent's root instead of claiming a root of
 *    its own. `['project-members', id]` is unreachable from `['projects']`, so
 *    every mutation that refreshed the parent left the child silently stale —
 *    the failure mode these rules remove.
 *
 * Rule 1 is enforced by `test/query-key-invariants.test.ts`, not by this
 * comment. A handful of sub-resources deliberately keep a root of their own,
 * because nesting would cost more than the staleness it fixes; each is listed
 * there with its reason, and the test fails both when a new key escapes its
 * root and when a listed exception stops being needed. A prose list here would
 * drift the first time someone added a key without reading it — which is the
 * disease this file treats.
 *
 * A factory is the only way to build a key: a raw literal at a call site is a
 * second definition that stops matching the moment either side moves. That rule
 * is enforced too — the same test scans every file under `admin/src` and fails
 * on an array literal handed to `queryKey` or to the query filters, because
 * within weeks of the rule landing seven of them had reappeared. Every family
 * exposes `all` because it is that family's invalidation prefix and the root
 * the invariant test measures its members against.
 *
 * **Where the keys live: `src/facades/<domain>/keys.ts`.** A family belongs to
 * the facade that reads and invalidates it, beside the hooks that do; the
 * invariant test walks every `keys.ts` under `src/facades` and holds the whole
 * union to both rules. Two kinds of key stay here: `paginationKeys`, which
 * builds a page key from *any* resource key and so belongs to no domain, and
 * the five families below, whose readers are pages and feature components with
 * no facade behind them yet — they move the day one appears, rather than
 * earning an empty facade directory now.
 */

/** A paged query inherits its resource key and adds its resolved page identity. */
export const paginationKeys = {
  page: (
    resourceKey: readonly unknown[],
    paramsKey: string,
    cursor: string | undefined,
    direction: string | undefined,
    limit: number,
  ) => [...resourceKey, paramsKey, cursor ?? null, direction ?? null, limit] as const,
}

export const auditLogKeys = {
  forAction: (action: string) => ['audit-log', action] as const,
}

export const budgetKeys = {
  all: ['budgets'] as const,
}

export const opsHealthKeys = {
  all: ['ops-health'] as const,
}

/** Owner-only local telemetry behind `/ops/usage` — never customer billing. */
export const opsTelemetryKeys = {
  connectorSummary: (groupBy: string) => ['connector-summary', groupBy] as const,
  fileUsageSummary: ['file-usage-summary'] as const,
  pricingProfiles: ['pricing-profiles'] as const,
  tokenByOutcome: ['token-by-outcome'] as const,
  tokenEstimate: ['token-estimate'] as const,
  tokenSummary: ['token-summary'] as const,
  tokenSummaryBy: (groupBy: string) => ['token-summary', groupBy] as const,
}

export const policyKeys = {
  rules: ['policy-rules'] as const,
}
