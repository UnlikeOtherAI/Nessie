import type { PrismaClient } from '@prisma/client'

// Org-level monthly LLM usage enforcement. A budget can cap on spend
// (token_ledger_events.estimated_cost_amount, USD) and/or on raw token volume
// (total_tokens) for the current calendar month (UTC). Token counts are always
// recorded, whereas cost is only populated when a pricing profile is configured —
// so the token cap is the dependable gate out of the box. checkBudget is the cheap
// hot-path gate (skips the spend query when enforcement is off); getBudgetStatus is
// the fuller read used for display/config.
//
// This is a SOFT monthly cap: spend is recorded only after a run completes, so the
// gate reads month-to-date usage that does not yet include in-flight runs. Several
// runs admitted in the same instant can therefore overshoot the cap before the next
// gate evaluation sees their spend. It is a cost-control guardrail, not a hard
// real-time ceiling.

export type BudgetCheck = {
  allowed: boolean
  reason: string | null
}

export type BudgetStatus = {
  enforced: boolean
  costLimitUsd: number | null
  spentUsd: number
  tokenLimit: number | null
  spentTokens: number
  allowed: boolean
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

const evaluate = (
  costLimitUsd: number | null,
  tokenLimit: number | null,
  spentUsd: number,
  spentTokens: number,
): BudgetCheck => {
  if (costLimitUsd !== null && spentUsd >= costLimitUsd) {
    return {
      allowed: false,
      reason: `Monthly cost budget exceeded (${formatUsd(spentUsd)} of ${formatUsd(costLimitUsd)})`,
    }
  }
  if (tokenLimit !== null && spentTokens >= tokenLimit) {
    return {
      allowed: false,
      reason: `Monthly token budget exceeded (${spentTokens.toLocaleString()} of ${tokenLimit.toLocaleString()} tokens)`,
    }
  }
  return { allowed: true, reason: null }
}

export const checkBudget = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<BudgetCheck> => {
  const config = await getBudgetConfig(prisma, organizationId)
  const enforced = config?.enforced ?? false
  const costLimitUsd = config?.monthlyCostLimitUsd ?? null
  const tokenLimit = config?.monthlyTokenLimit ?? null

  // Not enforcing (or no cap set): allow without paying for the usage query.
  if (!enforced || (costLimitUsd === null && tokenLimit === null)) {
    return { allowed: true, reason: null }
  }

  const { spentUsd, spentTokens } = await getMonthToDateUsage(prisma, organizationId)
  return evaluate(costLimitUsd, tokenLimit, spentUsd, spentTokens)
}

export const getBudgetStatus = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<BudgetStatus> => {
  const config = await getBudgetConfig(prisma, organizationId)
  const enforced = config?.enforced ?? false
  const costLimitUsd = config?.monthlyCostLimitUsd ?? null
  const tokenLimit = config?.monthlyTokenLimit ?? null
  const [{ spentUsd, spentTokens }, pricingProfiles] = await Promise.all([
    getMonthToDateUsage(prisma, organizationId),
    prisma.modelPricingProfile.count({ where: { organizationId } }),
  ])
  const allowed = !enforced || evaluate(costLimitUsd, tokenLimit, spentUsd, spentTokens).allowed
  return {
    enforced,
    costLimitUsd,
    spentUsd,
    tokenLimit,
    spentTokens,
    allowed,
    costTrackingActive: pricingProfiles > 0,
  }
}

export const setBudgetConfig = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    monthlyCostLimitUsd: number | null
    monthlyTokenLimit: number | null
    enforced: boolean
  },
): Promise<BudgetStatus> => {
  await prisma.organizationBudget.upsert({
    where: { organizationId },
    create: { organizationId, ...input },
    update: input,
  })
  return getBudgetStatus(prisma, organizationId)
}
