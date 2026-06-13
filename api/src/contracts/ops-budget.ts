import { z } from 'zod'

import { TimestampSchema } from './shared.js'

// ─── Ops health (observability) ───────────────────────────────────────────

export const WorkerHealthStatusSchema = z.enum(['up', 'stale', 'down'])
export type WorkerHealthStatus = z.infer<typeof WorkerHealthStatusSchema>

export const OpsWorkerHealthSchema = z.object({
  status: WorkerHealthStatusSchema,
  activeRunners: z.number().int().nonnegative(),
  lastHeartbeatAt: z.string().nullable(),
  heartbeatAgeSeconds: z.number().int().nonnegative().nullable(),
})

export const OpsDeadJobSchema = z.object({
  id: z.string(),
  topic: z.string(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  errorMessage: z.string().nullable(),
  enqueuedAt: TimestampSchema,
})

export const OpsDeadLetterSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
})

export const OpsHealthResponseSchema = z.object({
  worker: OpsWorkerHealthSchema,
  queue: z.object({
    pending: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
  }),
  deadJobs: z.array(OpsDeadJobSchema),
  deadLetters: z.object({
    count: z.number().int().nonnegative(),
    recent: z.array(OpsDeadLetterSchema),
  }),
})
export type OpsHealthResponse = z.infer<typeof OpsHealthResponseSchema>

export const ReadinessResponseSchema = z.object({
  ready: z.boolean(),
  checks: z.object({
    database: z.boolean(),
    worker: WorkerHealthStatusSchema,
  }),
})
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>

// ─── Budget (spend enforcement) ───────────────────────────────────────────

export const BudgetModeSchema = z.enum(['off', 'warn', 'enforce', 'degrade', 'unlimited'])
export const BudgetScopeTypeSchema = z.enum(['organization', 'project', 'team'])
export const BudgetPeriodSchema = z.enum(['weekly', 'monthly', 'yearly'])
export const BudgetScopeIdSchema = z.string().uuid()

export const BudgetStatusResponseSchema = z.object({
  scopeType: BudgetScopeTypeSchema,
  scopeId: z.string(),
  mode: BudgetModeSchema,
  period: BudgetPeriodSchema,
  costLimitUsd: z.number().nonnegative().nullable(),
  tokenLimit: z.number().int().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  spentTokens: z.number().int().nonnegative(),
  // Read side is lenient (the strict 1–100 bound is enforced on the write schema
  // below) so an out-of-range stored value can never 500 the status read.
  warnThresholdPercent: z.number().int(),
  blockHumansWhenOver: z.boolean(),
  degradeModel: z.string().nullable(),
  degradeProvider: z.string().nullable(),
  level: z.enum(['ok', 'warn', 'over']),
  percentUsed: z.number().int().nonnegative().nullable(),
  costTrackingActive: z.boolean(),
  // Storage quota for this scope (BigInt bytes serialized as strings). limit is
  // null when no cap is configured; used is the current stored-bytes total.
  storageLimitBytes: z.string().nullable(),
  storageUsedBytes: z.string(),
})

export const SetBudgetBodySchema = z
  .object({
    scopeType: BudgetScopeTypeSchema,
    scopeId: BudgetScopeIdSchema,
    costLimitUsd: z.number().nonnegative().nullable(),
    tokenLimit: z.number().int().nonnegative().nullable(),
    mode: BudgetModeSchema,
    period: BudgetPeriodSchema,
    warnThresholdPercent: z.number().int().min(1).max(100),
    blockHumansWhenOver: z.boolean(),
    degradeModel: z.string().min(1).nullable(),
    degradeProvider: z.string().min(1).nullable(),
    // Storage quota in bytes for this scope (null = unlimited). Within JS safe
    // integer range up to ~9 PB, so a plain number is sufficient from the client.
    storageLimitBytes: z.number().int().nonnegative().nullable().default(null),
  })
  // Degrade mode is meaningless without a fallback model; reject the config rather
  // than letting checkBudget silently fall back to allowing over-budget runs.
  .superRefine((value, ctx) => {
    if (value.mode === 'degrade' && !value.degradeModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['degradeModel'],
        message: 'degradeModel is required when mode is degrade',
      })
    }
  })
