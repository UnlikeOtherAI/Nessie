import type { PrismaClient } from '@prisma/client'

import type { LedgerInvocation } from './ledger.js'

// How the token ledger turns usage into an estimated cost: which price applies
// (`findActivePricingProfile`), what an invocation costs at it
// (`calculateEstimatedCost`), and valuing past usage recorded before a price
// was known (`recomputeTokenLedgerCosts`). The writer in ./ledger.ts records
// usage; this file prices it. Every figure it produces is an estimate —
// docs/token-ledger-spec.md §4 — never a charge.

export type ActivePricingProfile = {
  id: string
  source: 'provider_default' | 'org_override' | 'team_override' | 'manual'
  currency: string
  inputPerMillion: number | null
  outputPerMillion: number | null
  cachedInputPerMillion: number | null
  cachedOutputPerMillion: number | null
  cacheReadPerMillion: number | null
  cacheWritePerMillion: number | null
}

const decimalToNumber = (value: { toNumber: () => number } | null): number | null =>
  value === null ? null : value.toNumber()

/**
 * How strongly a candidate profile applies; lower wins. An owner's own price —
 * whatever its specificity — beats the model service's published one
 * (`provider_default`, docs/token-ledger-spec.md §4), and within each an exact
 * model beats the provider-wide `*`. Ties (never expected: one active row per
 * pattern is a partial unique index) go to the newest.
 */
const pricingRank = (row: { modelPattern: string; source: ActivePricingProfile['source'] }): number =>
  (row.source === 'provider_default' ? 2 : 0) + (row.modelPattern === '*' ? 1 : 0)

/**
 * The price usage of one provider and model is estimated at, for one
 * organisation, or null when none is known. The one selection every estimate
 * reads: the usage writer, historical re-pricing and the worker's cache-read
 * weight.
 */
export const findActivePricingProfile = async (
  prisma: Pick<PrismaClient, 'modelPricingProfile'>,
  organizationId: string,
  provider: string,
  model: string,
): Promise<ActivePricingProfile | null> => {
  const rows = await prisma.modelPricingProfile.findMany({
    where: {
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] }],
      organizationId,
      OR: [{ modelPattern: model }, { modelPattern: '*' }],
      provider,
    },
    select: {
      cacheReadPerMillion: true,
      cacheWritePerMillion: true,
      cachedInputPerMillion: true,
      cachedOutputPerMillion: true,
      currency: true,
      effectiveFrom: true,
      id: true,
      inputPerMillion: true,
      modelPattern: true,
      outputPerMillion: true,
      source: true,
    },
  })
  const row = rows.sort((left, right) =>
    pricingRank(left) - pricingRank(right)
    || right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0]
  if (!row) {
    return null
  }
  return {
    id: row.id,
    source: row.source,
    currency: row.currency,
    inputPerMillion: decimalToNumber(row.inputPerMillion),
    outputPerMillion: decimalToNumber(row.outputPerMillion),
    cachedInputPerMillion: decimalToNumber(row.cachedInputPerMillion),
    cachedOutputPerMillion: decimalToNumber(row.cachedOutputPerMillion),
    cacheReadPerMillion: decimalToNumber(row.cacheReadPerMillion),
    cacheWritePerMillion: decimalToNumber(row.cacheWritePerMillion),
  }
}

export const calculateEstimatedCost = (
  usage: LedgerInvocation['usage'],
  pricing: ActivePricingProfile | null,
): number | null => {
  if (!pricing) {
    return null
  }
  let amount = 0
  if (usage.inputTokens && pricing.inputPerMillion) {
    amount += (usage.inputTokens / 1_000_000) * pricing.inputPerMillion
  }
  if (usage.outputTokens && pricing.outputPerMillion) {
    amount += (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  }
  // Cache rates fall back to the matching base rate so cached tokens are never
  // billed at $0 when only input/output rates are configured. When a cheaper
  // cache rate IS set, the discount is applied.
  const cacheInputRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion
  if (usage.cachedInputTokens && cacheInputRate) {
    amount += (usage.cachedInputTokens / 1_000_000) * cacheInputRate
  }
  const cacheOutputRate = pricing.cachedOutputPerMillion ?? pricing.outputPerMillion
  if (usage.cachedOutputTokens && cacheOutputRate) {
    amount += (usage.cachedOutputTokens / 1_000_000) * cacheOutputRate
  }
  const cacheReadRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion
  if (usage.cacheReadTokens && cacheReadRate) {
    amount += (usage.cacheReadTokens / 1_000_000) * cacheReadRate
  }
  const cacheWriteRate = pricing.cacheWritePerMillion ?? pricing.inputPerMillion
  if (usage.cacheWriteTokens && cacheWriteRate) {
    amount += (usage.cacheWriteTokens / 1_000_000) * cacheWriteRate
  }
  return amount
}

/**
 * Value historical token usage that was recorded before any pricing existed.
 * estimated_cost_amount is computed at write time, so events logged while the
 * org had no ModelPricingProfile stay null forever. This re-prices ONLY those
 * still-null events using the current active profile per (provider, model) —
 * already-priced rows are left untouched, so historical accuracy is preserved.
 * One arithmetic UPDATE per (provider, model) pair (cheap, exact).
 *
 * Only usage the organisation paid for through the model service is priced. A
 * personal plan's or an own computer's usage is null by design, not because no
 * price was known — `recordInferenceUsage` refuses to price it — and re-pricing
 * it would put money nobody spent into owner totals and budgets.
 */
export const recomputeTokenLedgerCosts = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<{ updatedEvents: number; pricedPairs: number; unpricedPairs: number }> => {
  const pairs = await prisma.tokenLedgerEvent.groupBy({
    by: ['provider', 'model'],
    where: { billingSource: 'ledger', organizationId, estimatedCostAmount: null },
  })

  let updatedEvents = 0
  let pricedPairs = 0
  let unpricedPairs = 0

  for (const pair of pairs) {
    const pricing = await findActivePricingProfile(prisma, organizationId, pair.provider, pair.model)
    if (!pricing) {
      unpricedPairs += 1
      continue
    }
    // Mirror calculateEstimatedCost: cache rates fall back to the base rate so
    // cached tokens are never valued at $0 when only base rates are set.
    const inputRate = pricing.inputPerMillion ?? 0
    const outputRate = pricing.outputPerMillion ?? 0
    const cacheInputRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion ?? 0
    const cacheOutputRate = pricing.cachedOutputPerMillion ?? pricing.outputPerMillion ?? 0
    const cacheReadRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion ?? 0
    const cacheWriteRate = pricing.cacheWritePerMillion ?? pricing.inputPerMillion ?? 0

    const updated = await prisma.$executeRaw`
      UPDATE token_ledger_events SET
        estimated_cost_amount =
            COALESCE(input_tokens, 0)::numeric / 1000000 * ${inputRate}
          + COALESCE(output_tokens, 0)::numeric / 1000000 * ${outputRate}
          + COALESCE(cached_input_tokens, 0)::numeric / 1000000 * ${cacheInputRate}
          + COALESCE(cached_output_tokens, 0)::numeric / 1000000 * ${cacheOutputRate}
          + COALESCE(cache_read_tokens, 0)::numeric / 1000000 * ${cacheReadRate}
          + COALESCE(cache_write_tokens, 0)::numeric / 1000000 * ${cacheWriteRate},
        estimated_cost_currency = ${pricing.currency},
        pricing_profile_id = ${pricing.id}::uuid
      WHERE organization_id = ${organizationId}::uuid
        AND provider = ${pair.provider}
        AND model = ${pair.model}
        AND billing_source = 'ledger'
        AND estimated_cost_amount IS NULL
    `
    updatedEvents += Number(updated)
    pricedPairs += 1
  }

  return { updatedEvents, pricedPairs, unpricedPairs }
}
