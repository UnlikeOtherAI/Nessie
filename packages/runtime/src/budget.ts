import type { PrismaClient } from '@prisma/client'

// Scoped, period-based LLM usage governance. A Budget row governs an organization,
// project, or team and caps spend (token_ledger_events.estimated_cost_amount, USD)
// and/or token volume (total_tokens) over a calendar period (week/month/year, UTC).
// Spend is attributed to a scope the same way the ledger records it — by the run's
// actorContext.tenant (organizationId / projectId / teamId).
//
// Resolution is MOST-SPECIFIC-FIRST: for a run, the governing budget is the team
// budget if one is configured (mode != off), else the project budget, else the org
// budget. An "off" budget means "no budget here — inherit the parent". The modes:
//   off       — not configured here; resolution falls through to the parent scope.
//   warn      — governs here; never blocks; surfaces usage % + ok/warn/over level.
//   enforce   — governs here; throttles non-interactive (automation) runs once over
//               cap; a live human turn passes unless blockHumansWhenOver is set.
//   unlimited — explicit no-cap override; governs here (stops inheritance) and never
//               blocks. Use it to exempt a critical project/team from an ancestor cap.
//
// This is a SOFT cap: spend is recorded only after a run completes, so the gate
// reads period-to-date usage excluding in-flight runs and can overshoot slightly.

export type BudgetMode = 'off' | 'warn' | 'enforce' | 'unlimited'
export type BudgetScopeType = 'organization' | 'project' | 'team'
export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly'
export type BudgetLevel = 'ok' | 'warn' | 'over'

export type BudgetScope = {
  organizationId: string
  projectId?: string | null
  teamId?: string | null
}

export type BudgetCheck = { allowed: boolean; reason: string | null }

export type BudgetStatus = {
  scopeType: BudgetScopeType
  scopeId: string
  mode: BudgetMode
  period: BudgetPeriod
  costLimitUsd: number | null
  tokenLimit: number | null
  spentUsd: number
  spentTokens: number
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
  level: BudgetLevel
  percentUsed: number | null
  costTrackingActive: boolean
}

type BudgetRow = {
  organizationId: string
  scopeType: BudgetScopeType
  scopeId: string
  costLimitUsd: number | null
  tokenLimit: number | null
  mode: BudgetMode
  period: BudgetPeriod
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
}

// cost_limit_usd is a Prisma Decimal at runtime; normalize it to a JS number so
// the numeric comparisons (>=, /) below are correct rather than Decimal-vs-number.
type RawBudgetRow = Omit<BudgetRow, 'costLimitUsd'> & {
  costLimitUsd: { toNumber(): number } | null
}

const toBudgetRow = (raw: RawBudgetRow): BudgetRow => ({
  organizationId: raw.organizationId,
  scopeType: raw.scopeType,
  scopeId: raw.scopeId,
  costLimitUsd: raw.costLimitUsd === null ? null : raw.costLimitUsd.toNumber(),
  tokenLimit: raw.tokenLimit,
  mode: raw.mode,
  period: raw.period,
  warnThresholdPercent: raw.warnThresholdPercent,
  blockHumansWhenOver: raw.blockHumansWhenOver,
})

const periodStartUtc = (period: BudgetPeriod, now: Date): Date => {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const date = now.getUTCDate()
  if (period === 'yearly') return new Date(Date.UTC(year, 0, 1))
  if (period === 'monthly') return new Date(Date.UTC(year, month, 1))
  // weekly: start of the current ISO week (Monday) in UTC.
  const dow = new Date(Date.UTC(year, month, date)).getUTCDay() // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7
  return new Date(Date.UTC(year, month, date - daysSinceMonday))
}

const periodLabel: Record<BudgetPeriod, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
}

const scopeUsageWhere = (row: Pick<BudgetRow, 'scopeType' | 'scopeId'>) => {
  if (row.scopeType === 'team') return { teamId: row.scopeId }
  if (row.scopeType === 'project') return { projectId: row.scopeId }
  return { organizationId: row.scopeId }
}

const getPeriodUsage = async (
  prisma: PrismaClient,
  where: Record<string, unknown>,
  period: BudgetPeriod,
): Promise<{ spentUsd: number; spentTokens: number }> => {
  const result = await prisma.tokenLedgerEvent.aggregate({
    _sum: { estimatedCostAmount: true, totalTokens: true },
    where: { ...where, occurredAt: { gte: periodStartUtc(period, new Date()) } },
  })
  return {
    spentUsd: result._sum.estimatedCostAmount?.toNumber() ?? 0,
    spentTokens: result._sum.totalTokens ?? 0,
  }
}

const formatUsd = (value: number): string => `$${value.toFixed(2)}`

const overCapReason = (row: BudgetRow, spentUsd: number, spentTokens: number): string | null => {
  const label = periodLabel[row.period]
  if (row.costLimitUsd !== null && spentUsd >= row.costLimitUsd) {
    return `${label} cost budget exceeded (${formatUsd(spentUsd)} of ${formatUsd(row.costLimitUsd)})`
  }
  if (row.tokenLimit !== null && spentTokens >= row.tokenLimit) {
    return `${label} token budget exceeded (${spentTokens.toLocaleString()} of ${row.tokenLimit.toLocaleString()} tokens)`
  }
  return null
}

const percentOf = (spent: number, limit: number | null): number | null =>
  limit !== null && limit > 0 ? (spent / limit) * 100 : null

const maxPercent = (row: BudgetRow, spentUsd: number, spentTokens: number): number | null => {
  const parts = [percentOf(spentUsd, row.costLimitUsd), percentOf(spentTokens, row.tokenLimit)].filter(
    (value): value is number => value !== null,
  )
  return parts.length === 0 ? null : Math.round(Math.max(...parts))
}

// The governing budget for a run: most-specific scope whose mode is not 'off'.
const resolveBudget = async (
  prisma: PrismaClient,
  scope: BudgetScope,
): Promise<BudgetRow | null> => {
  const candidates: Array<{ scopeType: BudgetScopeType; scopeId: string }> = []
  if (scope.teamId) candidates.push({ scopeType: 'team', scopeId: scope.teamId })
  if (scope.projectId) candidates.push({ scopeType: 'project', scopeId: scope.projectId })
  candidates.push({ scopeType: 'organization', scopeId: scope.organizationId })

  const rows = (
    await prisma.budget.findMany({
      where: { OR: candidates.map((c) => ({ scopeType: c.scopeType, scopeId: c.scopeId })) },
    })
  ).map(toBudgetRow)

  for (const candidate of candidates) {
    const row = rows.find(
      (r) => r.scopeType === candidate.scopeType && r.scopeId === candidate.scopeId,
    )
    if (row && row.mode !== 'off') return row
  }
  return null
}

export const checkBudget = async (
  prisma: PrismaClient,
  scope: BudgetScope,
  opts: { isHuman: boolean },
): Promise<BudgetCheck> => {
  const budget = await resolveBudget(prisma, scope)

  // No governing budget, or a non-blocking mode: allow.
  if (!budget || budget.mode !== 'enforce') {
    return { allowed: true, reason: null }
  }
  if (budget.costLimitUsd === null && budget.tokenLimit === null) {
    return { allowed: true, reason: null }
  }

  const { spentUsd, spentTokens } = await getPeriodUsage(
    prisma,
    scopeUsageWhere(budget),
    budget.period,
  )
  const reason = overCapReason(budget, spentUsd, spentTokens)
  if (reason === null) {
    return { allowed: true, reason: null }
  }

  // Over cap: a live human turn passes unless the org opted into blocking people.
  if (opts.isHuman && !budget.blockHumansWhenOver) {
    return { allowed: true, reason: null }
  }
  return { allowed: false, reason }
}

const statusForRow = async (prisma: PrismaClient, row: BudgetRow): Promise<BudgetStatus> => {
  const [{ spentUsd, spentTokens }, pricingProfiles] = await Promise.all([
    getPeriodUsage(prisma, scopeUsageWhere(row), row.period),
    prisma.modelPricingProfile.count({ where: { organizationId: row.organizationId } }),
  ])
  const over = overCapReason(row, spentUsd, spentTokens) !== null
  const percentUsed = maxPercent(row, spentUsd, spentTokens)
  const warnReached = percentUsed !== null && percentUsed >= row.warnThresholdPercent
  const level: BudgetLevel = over ? 'over' : warnReached ? 'warn' : 'ok'
  return {
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    mode: row.mode,
    period: row.period,
    costLimitUsd: row.costLimitUsd,
    tokenLimit: row.tokenLimit,
    spentUsd,
    spentTokens,
    warnThresholdPercent: row.warnThresholdPercent,
    blockHumansWhenOver: row.blockHumansWhenOver,
    level,
    percentUsed,
    costTrackingActive: pricingProfiles > 0,
  }
}

export const listBudgetStatuses = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<BudgetStatus[]> => {
  const rows = (
    await prisma.budget.findMany({
      where: { organizationId },
      orderBy: [{ scopeType: 'asc' }, { createdAt: 'asc' }],
    })
  ).map(toBudgetRow)
  return Promise.all(rows.map((row) => statusForRow(prisma, row)))
}

export const setBudgetConfig = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    scopeType: BudgetScopeType
    scopeId: string
    costLimitUsd: number | null
    tokenLimit: number | null
    mode: BudgetMode
    period: BudgetPeriod
    warnThresholdPercent: number
    blockHumansWhenOver: boolean
  },
): Promise<BudgetStatus> => {
  const { organizationId, scopeType, scopeId, ...rest } = input
  const row = toBudgetRow(
    await prisma.budget.upsert({
      where: { scopeType_scopeId: { scopeType, scopeId } },
      create: { organizationId, scopeType, scopeId, ...rest },
      update: { organizationId, ...rest },
    }),
  )
  return statusForRow(prisma, row)
}

export const deleteBudget = async (
  prisma: PrismaClient,
  organizationId: string,
  scopeType: BudgetScopeType,
  scopeId: string,
): Promise<boolean> => {
  const { count } = await prisma.budget.deleteMany({
    where: { organizationId, scopeType, scopeId },
  })
  return count > 0
}
