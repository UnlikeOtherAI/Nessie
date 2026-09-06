import type { RunStatus } from '@prisma/client'

import type { AdmissionPrismaClient } from './admission-lock.js'

// Type-only, so this is erased at compile time and no module cycle exists at
// runtime: `budget.ts` imports the functions here, never the other way round.
import type { BudgetScopeType } from './budget.js'

/**
 * In-flight budget reservations — the half of the spend gate that makes it an
 * admission control rather than an observation.
 *
 * `token_ledger_events` is written when a run RECORDS usage, which is at best
 * the end of the run. Every gate read before that saw the same period total, so
 * N runs starting together were each admitted against a world where none of the
 * others existed. On one instance that was the documented "soft cap"; on N it
 * is unbounded. A reservation is the admitted run's own ceiling, written in the
 * same transaction that decided to admit it, so the next admitter counts it.
 *
 * It is an ESTIMATE and is treated as one: only `admitRunToBudget` reads these
 * rows. Owner-facing usage totals and the mid-run recheck stay on recorded
 * spend, so nobody is shown an estimate as money spent and no run is throttled
 * by its own reservation.
 */

/**
 * Reservations for a run in one of these states are dead weight — the run will
 * never spend again, and whatever it did spend is in the ledger. The aggregate
 * skips them so a crashed run cannot hold budget hostage until the sweep runs.
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
]

/**
 * What an admitted run is assumed to be able to spend before it records
 * anything. The caller resolves it from the run's configured ceiling
 * (`Agent.runLimits`, else the `NESSIE_RUN_BACKSTOP_*` envelope) — see
 * docs/standards/tech-and-run-budgets.md.
 */
export type BudgetReservationEstimate = {
  costUsd: number
  tokens: number
}

export type ReservationTarget = {
  organizationId: string
  scopeType: BudgetScopeType
  scopeId: string
}

/**
 * Every open reservation against one budget scope in the current period.
 * `period` is the caller's already-computed period start, so the reservation
 * window is byte-identical to the ledger window it is added to.
 */
export const sumOpenReservations = async (
  prisma: AdmissionPrismaClient,
  target: Pick<ReservationTarget, 'scopeType' | 'scopeId'>,
  periodStart: Date,
): Promise<{ reservedUsd: number; reservedTokens: number }> => {
  const result = await prisma.budgetReservation.aggregate({
    _sum: { reservedCostUsd: true, reservedTokens: true },
    where: {
      scopeType: target.scopeType,
      scopeId: target.scopeId,
      createdAt: { gte: periodStart },
      run: { status: { notIn: [...TERMINAL_RUN_STATUSES] } },
    },
  })
  return {
    reservedUsd: result._sum.reservedCostUsd?.toNumber() ?? 0,
    reservedTokens: result._sum.reservedTokens ?? 0,
  }
}

/**
 * Record the admission. Called only from inside the admission transaction, so
 * it is covered by the same advisory lock that made the usage read safe.
 *
 * Upsert, not create: a redelivered `run.execute` job re-admits the same run and
 * must replace its own reservation rather than reserve twice.
 */
export const reserveRunBudget = async (
  prisma: AdmissionPrismaClient,
  input: {
    target: ReservationTarget
    runId: string
    estimate: BudgetReservationEstimate
  },
): Promise<void> => {
  const data = {
    organizationId: input.target.organizationId,
    scopeType: input.target.scopeType,
    scopeId: input.target.scopeId,
    reservedCostUsd: input.estimate.costUsd,
    reservedTokens: input.estimate.tokens,
  }
  await prisma.budgetReservation.upsert({
    where: { runId: input.runId },
    create: { ...data, runId: input.runId },
    // The clock moves too: a re-admitted run is in flight from now, so its
    // reservation belongs to the period the re-admission happened in.
    update: { ...data, createdAt: new Date() },
  })
}

/**
 * Drop a run's reservation because its real spend is now on the ledger. Called
 * from the single ledger writer, so no terminal path can forget it; idempotent,
 * so a run that records usage more than once is not an error.
 */
export const releaseBudgetReservation = async (
  prisma: AdmissionPrismaClient,
  runId: string,
): Promise<void> => {
  await prisma.budgetReservation.deleteMany({ where: { runId } })
}

/**
 * Hygiene for reservations belonging to runs that ended without ever recording
 * usage. The aggregate already ignores them, so this frees rows rather than
 * budget; idempotent, and safe to run from every replica at once.
 */
export const deleteSettledBudgetReservations = async (
  prisma: AdmissionPrismaClient,
): Promise<number> => {
  const { count } = await prisma.budgetReservation.deleteMany({
    where: { run: { status: { in: [...TERMINAL_RUN_STATUSES] } } },
  })
  return count
}
