import type { PrismaClient } from '@prisma/client'

import {
  type BudgetLevel,
  type BudgetMode,
  type BudgetPeriod,
  type BudgetRow,
  type BudgetScopeType,
  getPeriodUsage,
  maxPercent,
  overCapReason,
  toBudgetRow,
} from './budget.js'
import { currentStorageUsageBytes } from './ledger.js'

/**
 * The owner-facing face of budgets: read what every scope has spent, set a
 * scope's configuration, remove it.
 *
 * Deliberately separate from the gate in `budget.ts`. The gate answers one
 * question under a lock and must stay small enough to read in one sitting;
 * this is CRUD over the same rows, behind the ops surfaces (`/ops/usage`,
 * `api/src/contracts/ops-budget.ts`). The numbers here are RECORDED spend only
 * — in-flight admission reservations are never added, so nobody is ever shown
 * an estimate as money spent.
 */

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
  degradeModel: string | null
  degradeProvider: string | null
  level: BudgetLevel
  percentUsed: number | null
  costTrackingActive: boolean
  // Storage quota for this scope (BigInt bytes as strings for JSON safety).
  storageLimitBytes: string | null
  storageUsedBytes: string
}
// Stored-bytes usage scope for a budget row (org scopeId is the organization id).
const storageScopeForRow = (row: BudgetRow) => {
  if (row.scopeType === 'project') {
    return { organizationId: row.organizationId, projectId: row.scopeId }
  }
  if (row.scopeType === 'team') {
    return { organizationId: row.organizationId, teamId: row.scopeId }
  }
  return { organizationId: row.scopeId }
}

const statusForRow = async (prisma: PrismaClient, row: BudgetRow): Promise<BudgetStatus> => {
  const [{ spentUsd, spentTokens }, pricingProfiles, storageUsedBytes] = await Promise.all([
    getPeriodUsage(prisma, row),
    prisma.modelPricingProfile.count({ where: { organizationId: row.organizationId } }),
    currentStorageUsageBytes(prisma, storageScopeForRow(row)),
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
    degradeModel: row.degradeModel,
    degradeProvider: row.degradeProvider,
    level,
    percentUsed,
    costTrackingActive: pricingProfiles > 0,
    storageLimitBytes: row.storageLimitBytes === null ? null : row.storageLimitBytes.toString(),
    storageUsedBytes: storageUsedBytes.toString(),
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
    storageLimitBytes?: number | null
    mode: BudgetMode
    period: BudgetPeriod
    warnThresholdPercent: number
    blockHumansWhenOver: boolean
    degradeModel: string | null
    degradeProvider: string | null
  },
): Promise<BudgetStatus> => {
  const { organizationId, scopeType, scopeId, storageLimitBytes, ...rest } = input
  const storageData = {
    storageLimitBytes: storageLimitBytes == null ? null : BigInt(storageLimitBytes),
  }
  const row = toBudgetRow(
    await prisma.budget.upsert({
      where: { scopeType_scopeId: { scopeType, scopeId } },
      create: { organizationId, scopeType, scopeId, ...rest, ...storageData },
      update: { organizationId, ...rest, ...storageData },
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
