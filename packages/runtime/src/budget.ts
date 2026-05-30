import type { PrismaClient } from '@prisma/client'

// Org-level monthly LLM usage governance. A budget caps spend
// (token_ledger_events.estimated_cost_amount, USD) and/or raw token volume
// (total_tokens) for the current calendar month (UTC). Token counts are always
// recorded, whereas cost is only populated when a pricing profile is configured —
// so the token cap is the dependable lever out of the box.
//
// Mode governs behaviour, and the design goal is to NOT block people:
//   off     — no checks at all (default).
//   warn    — never blocks; surfaces usage % and a warn/over level for alerting.
//   enforce — blocks non-interactive runs once over cap, but lets a live human
//             conversational turn through unless the org has explicitly opted into
//             blockHumansWhenOver. "Interactive" is decided by the caller (the run
//             payload's `interactive` flag), NOT by who the actor is — so a manually
//             fired trigger or a spawned subtask is throttled even though a human
//             initiated it. Sub-agent/delegate calls are not gated separately; they
//             ride on their parent run's single check and are hard-capped by the
//             sub-agent budget.
//
// This is a SOFT monthly cap: spend is recorded only after a run completes, so the
// gate reads month-to-date usage that does not yet include in-flight runs. Several
// runs admitted at once can overshoot slightly before the next gate sees their spend.
// It is a cost-control guardrail, not a hard real-time ceiling.

export type BudgetMode = 'off' | 'warn' | 'enforce'

export type BudgetLevel = 'ok' | 'warn' | 'over'

export type BudgetCheck = {
  allowed: boolean
  reason: string | null
}

export type BudgetStatus = {
  mode: BudgetMode
  costLimitUsd: number | null
  spentUsd: number
  tokenLimit: number | null
  spentTokens: number
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
  level: BudgetLevel
  percentUsed: number | null
  // False when no pricing profile exists, meaning estimated cost is never
  // populated and a USD cap would be inert — the UI warns on this.
  costTrackingActive: boolean
}

const monthStartUtc = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

const getMonthToDateUsage = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<{ spentUsd: number; spentTokens: number }> => {
  const result = await prisma.tokenLedgerEvent.aggregate({
    _sum: { estimatedCostAmount: true, totalTokens: true },
    where: { organizationId, occurredAt: { gte: monthStartUtc(new Date()) } },
  })
  return {
    spentUsd: result._sum.estimatedCostAmount ?? 0,
    spentTokens: result._sum.totalTokens ?? 0,
  }
}

const getBudgetConfig = (prisma: PrismaClient, organizationId: string) =>
  prisma.organizationBudget.findUnique({ where: { organizationId } })

const formatUsd = (value: number): string => `$${value.toFixed(2)}`

// Returns the over-cap reason, or null when within both caps.
const overCapReason = (
  costLimitUsd: number | null,
  tokenLimit: number | null,
  spentUsd: number,
  spentTokens: number,
): string | null => {
  if (costLimitUsd !== null && spentUsd >= costLimitUsd) {
    return `Monthly cost budget exceeded (${formatUsd(spentUsd)} of ${formatUsd(costLimitUsd)})`
  }
  if (tokenLimit !== null && spentTokens >= tokenLimit) {
    return `Monthly token budget exceeded (${spentTokens.toLocaleString()} of ${tokenLimit.toLocaleString()} tokens)`
  }
  return null
}

const percentOf = (spent: number, limit: number | null): number | null =>
  limit !== null && limit > 0 ? (spent / limit) * 100 : null

const maxPercent = (
  costLimitUsd: number | null,
  tokenLimit: number | null,
  spentUsd: number,
  spentTokens: number,
): number | null => {
  const parts = [percentOf(spentUsd, costLimitUsd), percentOf(spentTokens, tokenLimit)].filter(
    (value): value is number => value !== null,
  )
  return parts.length === 0 ? null : Math.round(Math.max(...parts))
}

export const checkBudget = async (
  prisma: PrismaClient,
  organizationId: string,
  opts: { isHuman: boolean },
): Promise<BudgetCheck> => {
  const config = await getBudgetConfig(prisma, organizationId)
  const mode = (config?.mode ?? 'off') as BudgetMode
  const costLimitUsd = config?.monthlyCostLimitUsd ?? null
  const tokenLimit = config?.monthlyTokenLimit ?? null

  // Only enforce mode ever blocks; off/warn always allow. Skip the spend query
  // entirely when there is nothing to enforce.
  if (mode !== 'enforce' || (costLimitUsd === null && tokenLimit === null)) {
    return { allowed: true, reason: null }
  }

  const { spentUsd, spentTokens } = await getMonthToDateUsage(prisma, organizationId)
  const reason = overCapReason(costLimitUsd, tokenLimit, spentUsd, spentTokens)
  if (reason === null) {
    return { allowed: true, reason: null }
  }

  // Over cap. A live human request is allowed through unless the org explicitly
  // opted into blocking people; automations are throttled.
  if (opts.isHuman && !(config?.blockHumansWhenOver ?? false)) {
    return { allowed: true, reason: null }
  }

  return { allowed: false, reason }
}

export const getBudgetStatus = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<BudgetStatus> => {
  const config = await getBudgetConfig(prisma, organizationId)
  const mode = (config?.mode ?? 'off') as BudgetMode
  const costLimitUsd = config?.monthlyCostLimitUsd ?? null
  const tokenLimit = config?.monthlyTokenLimit ?? null
  const warnThresholdPercent = config?.warnThresholdPercent ?? 80
  const blockHumansWhenOver = config?.blockHumansWhenOver ?? false

  const [{ spentUsd, spentTokens }, pricingProfiles] = await Promise.all([
    getMonthToDateUsage(prisma, organizationId),
    prisma.modelPricingProfile.count({ where: { organizationId } }),
  ])

  const over = overCapReason(costLimitUsd, tokenLimit, spentUsd, spentTokens) !== null
  const percentUsed = maxPercent(costLimitUsd, tokenLimit, spentUsd, spentTokens)
  const warnReached = percentUsed !== null && percentUsed >= warnThresholdPercent
  const level: BudgetLevel = over ? 'over' : warnReached ? 'warn' : 'ok'

  return {
    mode,
    costLimitUsd,
    spentUsd,
    tokenLimit,
    spentTokens,
    warnThresholdPercent,
    blockHumansWhenOver,
    level,
    percentUsed,
    costTrackingActive: pricingProfiles > 0,
  }
}

export const setBudgetConfig = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    monthlyCostLimitUsd: number | null
    monthlyTokenLimit: number | null
    mode: BudgetMode
    warnThresholdPercent: number
    blockHumansWhenOver: boolean
  },
): Promise<BudgetStatus> => {
  await prisma.organizationBudget.upsert({
    where: { organizationId },
    create: { organizationId, ...input },
    update: input,
  })
  return getBudgetStatus(prisma, organizationId)
}
