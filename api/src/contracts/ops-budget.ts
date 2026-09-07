import { PricingSourceSchema } from '@nessie/schemas'
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

/**
 * One rate-limit bucket's CURRENT window, summed over every replica.
 *
 * Read from `rate_limit_buckets`, which is where every API instance counts, so
 * these are the deployment's numbers rather than one process's share of them
 * (audit 1.13, plan row 5.9). `limitedIdentities` is how many identities are
 * locked out of this bucket right now — the number an operator is actually
 * asking about when they open this page during an incident.
 */
export const OpsRateLimitBucketSchema = z.object({
  bucket: z.string(),
  limit: z.number().int().nonnegative(),
  windowMs: z.number().int().positive(),
  identities: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  maxCount: z.number().int().nonnegative(),
  limitedIdentities: z.number().int().nonnegative(),
  windowStartedAt: TimestampSchema,
})

/**
 * The limiter block, split by what the numbers actually cover — the split is
 * the point of the shape. Mixing a fleet-wide count and a per-process one under
 * one flat object (which is what this used to be) leaves an operator reading a
 * number that means one Nth of what they think it does.
 */
export const OpsRateLimitSchema = z.object({
  /**
   * True for the whole deployment: read from the shared counter rows, so a
   * lockout counted on any replica appears here. `available` is false when that
   * read failed — zeros would be a measurement this endpoint did not make.
   */
  deploymentWide: z.object({
    available: z.boolean(),
    source: z.literal('rate_limit_buckets'),
    buckets: z.array(OpsRateLimitBucketSchema),
  }),
  /**
   * This API process only, since this process booted. Reported because a couple
   * of these have no deployment-wide equivalent — `storeErrors` counts hits that
   * never reached Postgres, so by construction they left no row to read — and
   * because a replica's share of `checks` is a cheap load-balance sanity check.
   * Never read one of these as a fleet total.
   */
  thisInstance: z.object({
    bootedAt: TimestampSchema,
    checks: z.number().int().nonnegative(),
    limited: z.number().int().nonnegative(),
    storeErrors: z.number().int().nonnegative(),
    limitedByBucket: z.record(z.string(), z.number().int().nonnegative()),
  }),
})
export type OpsRateLimit = z.infer<typeof OpsRateLimitSchema>

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
  rateLimit: OpsRateLimitSchema,
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

// ─── Model pricing (turns the usage ledger into dollars) ──────────────────────

const PerMillionRate = z.number().nonnegative().nullable().default(null)

// Per-million-token rates for a (provider, modelPattern). modelPattern matches an
// exact model or '*' as the provider-wide fallback.
export const SetPricingProfileBodySchema = z.object({
  provider: z.string().min(1).max(120),
  modelPattern: z.string().min(1).max(200),
  currency: z.string().min(1).max(8).default('USD'),
  source: PricingSourceSchema.default('manual'),
  inputPerMillion: PerMillionRate,
  outputPerMillion: PerMillionRate,
  cachedInputPerMillion: PerMillionRate,
  cachedOutputPerMillion: PerMillionRate,
  cacheReadPerMillion: PerMillionRate,
  cacheWritePerMillion: PerMillionRate,
})
