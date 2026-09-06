import type { PrismaClient } from '@prisma/client'

import { acquireAdmissionLock, type AdmissionPrismaClient } from './admission-lock.js'
import {
  type BudgetReservationEstimate,
  reserveRunBudget,
  sumOpenReservations,
} from './budget-reservations.js'

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
// ADMISSION GUARANTEE (enforce / degrade only). `admitRunToBudget` takes
// `pg_advisory_xact_lock` on the governing budget scope, reads usage, and writes
// the admitted run's reservation inside ONE transaction. Precisely:
//
//   Every admitter for one scope is serialised, and each one reads recorded
//   spend PLUS the full ceiling of every run admitted this period that has not
//   yet recorded any usage. Once that total reaches the cap, every later
//   admission is refused. So a run that has spent nothing yet is counted at
//   everything it COULD spend, and two runs that fit one at a time but not
//   together can never both be admitted — whatever the number of replicas.
//
// That is what changed. It used to be a SOFT cap in the worst way: the gate read
// only what had already been *recorded*, and a run records nothing until it has
// spent — so N replicas admitting at the same instant all read the same
// pre-run total and the overshoot grew with N.
//
// THE LIMIT OF THAT GUARANTEE, stated because an overclaimed cap is worse than
// an honestly documented soft one. A reservation is dropped as soon as the run
// records its FIRST usage (`recordInferenceUsage`) — leaving the estimate
// standing beside the real number would double-count it. From that moment the
// run is counted at what it has recorded, not at what it may still spend. A
// scope whose in-flight runs have each recorded a little is therefore measured
// below their combined ceilings, and admission can let further work in. "Past
// the cap by at most one ceiling" is exact while the competing runs have not
// started spending; across a period of long, partially-recorded runs the excess
// is bounded by their unrecorded headroom, not by a single ceiling.
//
// What is NOT promised at all, and never was this gate's job: an individual run
// finishing over cap. A run's own spend is bounded by its envelope
// (docs/standards/tech-and-run-budgets.md) and stopped mid-flight by the
// periodic recheck, which deliberately judges recorded spend only.
//
// `warn`, `unlimited`, `off` and limit-less budgets never block, so they never
// take the lock — an observation must not be able to queue behind a writer.

export type BudgetMode = 'off' | 'warn' | 'enforce' | 'degrade' | 'unlimited'
export type BudgetScopeType = 'organization' | 'project' | 'team'
export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly'
export type BudgetLevel = 'ok' | 'warn' | 'over'

export type BudgetScope = {
  organizationId: string
  projectId?: string | null
  teamId?: string | null
}

// The gate's decision for a run. 'degrade' keeps the run going but on a cheaper
// model instead of refusing — so nobody is blocked, spend just slows.
export type BudgetDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'degrade'; model: string; provider: string; reason: string }

// A read-only observation of the governing budget's period-to-date usage,
// produced ALONGSIDE (never in place of) the gate decision so callers can alert
// on a threshold crossing without changing the verdict. Present only for a
// governing budget that has a cost or token limit and a cap-aware mode
// (warn / enforce / degrade); null for unlimited, off, or no-limit budgets.
export type BudgetAlertSnapshot = {
  organizationId: string
  scopeType: BudgetScopeType
  scopeId: string
  mode: BudgetMode
  period: BudgetPeriod
  // Start of the current budget period (UTC) — the dedupe key for "alert once
  // per budget per period".
  periodStart: Date
  spentUsd: number
  costLimitUsd: number | null
  spentTokens: number
  tokenLimit: number | null
  percentUsed: number | null
  warnThresholdPercent: number
  level: BudgetLevel
}

// The gate's decision PLUS the observation used for alerting. `checkBudget`
// returns only `.decision`, so the verdict path is unchanged; alerting callers
// use `evaluateBudget` and read `.alert`.
export type BudgetEvaluation = {
  decision: BudgetDecision
  alert: BudgetAlertSnapshot | null
}

/**
 * The gate's normalised view of a `budgets` row. Exported for `budget-admin.ts`
 * only — it is the shape the two faces of this subsystem share, not a contract
 * for anything outside it.
 */
export type BudgetRow = {
  organizationId: string
  scopeType: BudgetScopeType
  scopeId: string
  costLimitUsd: number | null
  tokenLimit: number | null
  storageLimitBytes: bigint | null
  mode: BudgetMode
  period: BudgetPeriod
  warnThresholdPercent: number
  blockHumansWhenOver: boolean
  degradeModel: string | null
  degradeProvider: string | null
}

// cost_limit_usd is a Prisma Decimal at runtime; normalize it to a JS number so
// the numeric comparisons (>=, /) below are correct rather than Decimal-vs-number.
type RawBudgetRow = Omit<BudgetRow, 'costLimitUsd'> & {
  costLimitUsd: { toNumber(): number } | null
}

/** Shared with `budget-admin.ts`; see BudgetRow. */
export const toBudgetRow = (raw: RawBudgetRow): BudgetRow => ({
  organizationId: raw.organizationId,
  scopeType: raw.scopeType,
  scopeId: raw.scopeId,
  costLimitUsd: raw.costLimitUsd === null ? null : raw.costLimitUsd.toNumber(),
  tokenLimit: raw.tokenLimit,
  storageLimitBytes: raw.storageLimitBytes,
  mode: raw.mode,
  period: raw.period,
  warnThresholdPercent: raw.warnThresholdPercent,
  blockHumansWhenOver: raw.blockHumansWhenOver,
  degradeModel: raw.degradeModel,
  degradeProvider: raw.degradeProvider,
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

// Serialise every admitter against one governing budget scope. See
// ./admission-lock.ts for why this blocks rather than trying.
const acquireBudgetLock = (
  prisma: AdmissionPrismaClient,
  row: Pick<BudgetRow, 'scopeType' | 'scopeId'>,
): Promise<void> => acquireAdmissionLock(prisma, `budget:${row.scopeType}:${row.scopeId}`)

const scopeUsageWhere = (row: Pick<BudgetRow, 'scopeType' | 'scopeId'>) => {
  if (row.scopeType === 'team') return { teamId: row.scopeId }
  if (row.scopeType === 'project') return { projectId: row.scopeId }
  return { organizationId: row.scopeId }
}

type PeriodUsage = { spentUsd: number; spentTokens: number }

/** Recorded period-to-date spend: `token_ledger_events` and nothing else. */
export const getPeriodUsage = async (
  prisma: AdmissionPrismaClient,
  row: Pick<BudgetRow, 'scopeType' | 'scopeId' | 'period'>,
): Promise<PeriodUsage> => {
  const result = await prisma.tokenLedgerEvent.aggregate({
    _sum: { estimatedCostAmount: true, totalTokens: true },
    where: {
      ...scopeUsageWhere(row),
      occurredAt: { gte: periodStartUtc(row.period, new Date()) },
    },
  })
  return {
    spentUsd: result._sum.estimatedCostAmount?.toNumber() ?? 0,
    spentTokens: result._sum.totalTokens ?? 0,
  }
}

/**
 * Recorded spend PLUS the ceilings of runs already admitted this period and not
 * yet settled. This is the admission read and only the admission read: it is
 * what makes two concurrent admitters see each other, and it must never reach
 * an owner-facing number, because a reservation is an estimate and not money
 * anybody spent.
 */
const getAdmissionUsage = async (
  prisma: AdmissionPrismaClient,
  row: Pick<BudgetRow, 'scopeType' | 'scopeId' | 'period'>,
  recorded: PeriodUsage,
): Promise<PeriodUsage> => {
  const reserved = await sumOpenReservations(
    prisma,
    row,
    periodStartUtc(row.period, new Date()),
  )
  return {
    spentUsd: recorded.spentUsd + reserved.reservedUsd,
    spentTokens: recorded.spentTokens + reserved.reservedTokens,
  }
}

const formatUsd = (value: number): string => `$${value.toFixed(2)}`

export const overCapReason = (row: BudgetRow, spentUsd: number, spentTokens: number): string | null => {
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

export const maxPercent = (row: BudgetRow, spentUsd: number, spentTokens: number): number | null => {
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

// Alerting is observed against any governing budget with a limit and a
// cap-aware mode. `unlimited` is an explicit no-cap; `off` never resolves here.
const isCapAwareMode = (mode: BudgetMode): boolean =>
  mode === 'warn' || mode === 'enforce' || mode === 'degrade'

const buildAlertSnapshot = (
  row: BudgetRow,
  usage: { spentUsd: number; spentTokens: number },
): BudgetAlertSnapshot => {
  const over = overCapReason(row, usage.spentUsd, usage.spentTokens) !== null
  const percentUsed = maxPercent(row, usage.spentUsd, usage.spentTokens)
  const warnReached = percentUsed !== null && percentUsed >= row.warnThresholdPercent
  const level: BudgetLevel = over ? 'over' : warnReached ? 'warn' : 'ok'
  return {
    organizationId: row.organizationId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    mode: row.mode,
    period: row.period,
    periodStart: periodStartUtc(row.period, new Date()),
    spentUsd: usage.spentUsd,
    costLimitUsd: row.costLimitUsd,
    spentTokens: usage.spentTokens,
    tokenLimit: row.tokenLimit,
    percentUsed,
    warnThresholdPercent: row.warnThresholdPercent,
    level,
  }
}

// The verdict, factored out so it is provably identical between the usage the
// gate reads and the usage the alert snapshot reads (one query, two consumers).
const deriveDecision = (
  row: BudgetRow,
  usage: { spentUsd: number; spentTokens: number },
  isHuman: boolean,
): BudgetDecision => {
  const reason = overCapReason(row, usage.spentUsd, usage.spentTokens)
  if (reason === null) {
    return { action: 'allow' }
  }

  // Over cap. Degrade keeps the run going on the cheaper model (never blocks);
  // it falls back to allow if no degrade target is configured.
  if (row.mode === 'degrade') {
    if (row.degradeModel) {
      return {
        action: 'degrade',
        model: row.degradeModel,
        provider: row.degradeProvider ?? 'openai',
        reason,
      }
    }
    return { action: 'allow' }
  }

  // Enforce. A live human turn passes unless the org opted into blocking people.
  if (isHuman && !row.blockHumansWhenOver) {
    return { action: 'allow' }
  }
  return { action: 'block', reason }
}

// A budget that can refuse work. Exactly the budgets whose verdict depends on
// how much has been spent — and so exactly the ones an unlocked read can get
// wrong when two replicas ask at once.
const gatesOnSpend = (row: BudgetRow): boolean =>
  (row.mode === 'enforce' || row.mode === 'degrade')
  && (row.costLimitUsd !== null || row.tokenLimit !== null)

// The decision + alert for an already-resolved budget, so the admission path
// resolves the governing row once and reuses this for the modes it does not
// need to lock.
const evaluateResolved = async (
  prisma: AdmissionPrismaClient,
  budget: BudgetRow | null,
  opts: { isHuman: boolean },
): Promise<BudgetEvaluation> => {
  if (!budget) {
    return { decision: { action: 'allow' }, alert: null }
  }

  const hasLimit = budget.costLimitUsd !== null || budget.tokenLimit !== null

  // Only enforce and degrade act on spend; warn and unlimited always allow. But
  // warn budgets still produce an alert snapshot, so read usage when the budget
  // is cap-aware and has a limit even if the verdict is a foregone `allow`.
  if (budget.mode !== 'enforce' && budget.mode !== 'degrade') {
    if (isCapAwareMode(budget.mode) && hasLimit) {
      const usage = await getPeriodUsage(prisma, budget)
      return { decision: { action: 'allow' }, alert: buildAlertSnapshot(budget, usage) }
    }
    return { decision: { action: 'allow' }, alert: null }
  }
  if (!hasLimit) {
    return { decision: { action: 'allow' }, alert: null }
  }

  const usage = await getPeriodUsage(prisma, budget)
  return {
    decision: deriveDecision(budget, usage, opts.isHuman),
    alert: buildAlertSnapshot(budget, usage),
  }
}

// Evaluate the governing budget for a run: the gate DECISION plus a read-only
// ALERT snapshot. The decision is byte-identical to the legacy `checkBudget`
// logic; the snapshot is an additional observation and never influences the
// verdict. A single period-usage query feeds both.
//
// This is the OBSERVING read — no lock, no reservation, recorded spend only.
// It is what the mid-run recheck and the in-process API model calls use. A run
// entering the queue is admitted through `admitRunToBudget` instead.
export const evaluateBudget = async (
  prisma: PrismaClient,
  scope: BudgetScope,
  opts: { isHuman: boolean },
): Promise<BudgetEvaluation> =>
  evaluateResolved(prisma, await resolveBudget(prisma, scope), opts)

export const checkBudget = async (
  prisma: PrismaClient,
  scope: BudgetScope,
  opts: { isHuman: boolean },
): Promise<BudgetDecision> => (await evaluateBudget(prisma, scope, opts)).decision

/**
 * Admit a run against its governing budget, atomically.
 *
 * For `enforce`/`degrade` budgets with a limit this is one transaction that
 * takes `pg_advisory_xact_lock` on the governing scope, reads period usage
 * INCLUDING the reservations of runs already admitted and not yet settled, and
 * — when the verdict is not `block` — writes this run's own reservation before
 * committing. Two admitters whose ceilings fit one at a time but not together
 * therefore cannot both pass: the loser waits on the lock and then reads the
 * winner's reservation. See the ADMISSION GUARANTEE at the top of this file for
 * exactly what that does and does not promise.
 *
 * Every other mode returns the same verdict `evaluateBudget` would, with no
 * lock and no row written.
 */
export const admitRunToBudget = async (
  prisma: PrismaClient,
  scope: BudgetScope,
  opts: { isHuman: boolean; runId: string; estimate: BudgetReservationEstimate },
): Promise<BudgetEvaluation> => {
  // Resolved outside the transaction because the lock's NAME depends on which
  // scope governs. Two admitters racing each other read the same configuration
  // and so take the same lock; only an admin editing the budget in the same
  // instant could give them different names, and the next admission picks the
  // new one up.
  const budget = await resolveBudget(prisma, scope)
  if (!budget || !gatesOnSpend(budget)) {
    return evaluateResolved(prisma, budget, opts)
  }

  return prisma.$transaction(async (tx) => {
    await acquireBudgetLock(tx, budget)
    const recorded = await getPeriodUsage(tx, budget)
    const decision = deriveDecision(
      budget,
      await getAdmissionUsage(tx, budget, recorded),
      opts.isHuman,
    )
    if (decision.action !== 'block') {
      await reserveRunBudget(tx, {
        estimate: opts.estimate,
        runId: opts.runId,
        target: {
          organizationId: budget.organizationId,
          scopeId: budget.scopeId,
          scopeType: budget.scopeType,
        },
      })
    }
    // The alert reports RECORDED spend — its numbers become the sentence an
    // owner reads ("has used $X of $Y"), and an estimate has no business there.
    return { decision, alert: buildAlertSnapshot(budget, recorded) }
  })
}

