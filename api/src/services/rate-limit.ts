import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { writeAuditEntry } from '@nessie/db'
import { emitAuditEvent } from './audit.js'

/**
 * Brute-force protection for auth-sensitive endpoints (issue #211).
 *
 * Postgres-backed fixed-window counters (the deployment has no Redis): one
 * `rate_limit_buckets` row per (bucket, identity hash, window start),
 * incremented atomically so concurrent replicas count against the same row.
 * Windows are fixed rather than sliding: each identity carries at most two
 * live counters, the unique key makes increments idempotent per row, and
 * expired rows are deleted by the probabilistic cleanup below — a true
 * sliding log would need an unbounded event table and a transaction per hit.
 *
 * Raw IPs / user ids are never persisted: the store key is
 * sha256(`${bucket}:${identity}`).
 *
 * The store FAILS OPEN: any store error (outage, missing migration) logs a
 * loud line and allows the request. Availability beats lockout; a rate-limit
 * store must never take the login surface down with it.
 */

export type RateLimitRule = {
  max: number
  windowMs: number
}

export type RateLimitDecision = {
  limited: boolean
  bucket: string
  count: number
  limit: number
  retryAfterSeconds: number
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

const CLEANUP_PROBABILITY = 0.02

const hashIdentity = (bucket: string, identity: string): string =>
  createHash('sha256').update(`${bucket}:${identity}`).digest('hex')

/**
 * The synthetic actor/org context used for unauthenticated lockout audit
 * events: pre-login brute force has no real actor or org row, and the audit
 * hash chain is keyed by organization id, so a real org id would have to be
 * guessed. Events land under this dedicated zero UUID and the true identity
 * lives (hashed) in metadata.
 */
const SYSTEM_AUDIT_ORG_ID = '00000000-0000-0000-0000-000000000000'

type RateLimitLogger = {
  error: (msg: unknown, ...args: unknown[]) => void
}

const consoleLogger: RateLimitLogger = {
  error: (msg, ...args) => console.error(msg, ...args),
}

export class RateLimiter {
  /** Cumulative counters surfaced on /api/ops/health. */
  private readonly stats = {
    checks: 0,
    limited: 0,
    storeErrors: 0,
    limitedByBucket: new Map<string, number>(),
  }

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: RateLimitLogger = consoleLogger,
  ) {}

  snapshot() {
    return {
      checks: this.stats.checks,
      limited: this.stats.limited,
      storeErrors: this.stats.storeErrors,
      limitedByBucket: Object.fromEntries(this.stats.limitedByBucket),
    }
  }

  /**
   * Count one hit for `identity` under `bucket` + `rule`. The bucket is the
   * logical limiter name: it lives in the store key (and audit resourceId),
   * not in the rule — the rule is only `{max, windowMs}` thresholds so it can
   * be validated/loaded verbatim from config. IP identities are namespaced as
   * `ip:<addr>` so they can never collide with account ids.
   */
  async check(
    bucket: string,
    rule: RateLimitRule,
    identity: string,
  ): Promise<RateLimitDecision> {
    this.stats.checks += 1
    const now = Date.now()
    const windowStartMs = Math.floor(now / rule.windowMs) * rule.windowMs
    const keyHash = hashIdentity(bucket, identity)
    try {
      const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "rate_limit_buckets"
          ("id", "bucket", "key_hash", "window_start", "count", "updated_at")
        VALUES (
          ${randomUUID()}::uuid,
          ${bucket},
          ${keyHash},
          ${new Date(windowStartMs)},
          1,
          NOW()
        )
        ON CONFLICT ("bucket", "key_hash", "window_start")
        DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1,
                      "updated_at" = NOW()
        RETURNING "count"
      `
      const count = rows[0]?.count ?? 1
      // Bounded cleanup: 2% of hits sweep expired rows, keeping the table at
      // ~live keys per window without a background job.
      if (Math.random() < CLEANUP_PROBABILITY) {
        await this.prisma.$executeRaw`
          DELETE FROM "rate_limit_buckets" WHERE "window_start" < ${new Date(now - rule.windowMs)}
        `
      }
      const limited = count > rule.max
      if (limited) {
        this.stats.limited += 1
        this.stats.limitedByBucket.set(
          bucket,
          (this.stats.limitedByBucket.get(bucket) ?? 0) + 1,
        )
      }
      return {
        limited,
        bucket,
        count,
        limit: rule.max,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStartMs + rule.windowMs - now) / 1000),
        ),
      }
    } catch (error) {
      this.stats.storeErrors += 1
      this.logger.error(
        '[rate-limit] FAIL-OPEN: store unavailable, allowing request '
        + `(bucket=${bucket}): ${String(error)}`,
      )
      return {
        limited: false,
        bucket,
        count: 0,
        limit: rule.max,
        retryAfterSeconds: 0,
      }
    }
  }

  /**
   * IP + optional account check for one request. Both counters are recorded
   * on every hit (independently keyed, so per-IP and per-account lockouts
   * never interfere); the request is rejected when either trips.
   *
   * `auditContext` should be the caller's authenticated actor context for
   * authenticated routes; pass a session identity hint for unauthenticated
   * routes so the account counter still binds to one credential/session
   * (hashed, never plaintext) and the audit event lands in the right org.
   */
  async guard(input: {
    rules: {
      ip: { bucket: string; rule: RateLimitRule }
      account?: { bucket: string; rule: RateLimitRule }
    }
    ip: string
    accountIdentity?: string | null
    auditContext?: AuthorizedActionContext | null
    session?: { userId: string; organizationId: string } | null
    userAgent?: string | null
  }): Promise<RateLimitResult> {
    const ipDecision = await this.check(
      input.rules.ip.bucket,
      input.rules.ip.rule,
      `ip:${input.ip}`,
    )
    let accountDecision: RateLimitDecision | null = null
    if (input.rules.account && input.accountIdentity) {
      accountDecision = await this.check(
        input.rules.account.bucket,
        input.rules.account.rule,
        `account:${input.accountIdentity}`,
      )
    }

    const tripped = [ipDecision, accountDecision].find(
      (decision) => decision?.limited,
    )
    if (!tripped) {
      return { allowed: true }
    }

    await this.emitLockoutEvent({
      decisions: [ipDecision, accountDecision].filter(
        (decision): decision is RateLimitDecision => decision !== null,
      ),
      ip: input.ip,
      auditContext: input.auditContext ?? null,
      session: input.session ?? null,
      userAgent: input.userAgent ?? null,
    })

    const retryAfterSeconds = Math.max(
      ...[ipDecision, accountDecision]
        .filter((decision) => decision?.limited)
        .map((decision) => decision?.retryAfterSeconds ?? 0),
    )
    return { allowed: false, retryAfterSeconds }
  }

  private async emitLockoutEvent(input: {
    decisions: RateLimitDecision[]
    ip: string
    auditContext: AuthorizedActionContext | null
    session: { userId: string; organizationId: string } | null
    userAgent: string | null
  }): Promise<void> {
    const bucket = input.decisions[0]?.bucket ?? 'unknown'
    const metadata = {
      counts: Object.fromEntries(
        input.decisions.map((decision) => [
          decision.bucket,
          { count: decision.count, limit: decision.limit },
        ]),
      ),
      ipHash: hashIdentity('audit.ip', input.ip),
    }
    if (input.auditContext) {
      // Authenticated route: use the standard audit chokepoint so the event
      // joins the caller's org hash chain with real actor attribution.
      await emitAuditEvent(this.prisma, {
        actorContext: input.auditContext,
        action: 'auth.rate_limit.lockout',
        resourceType: 'rate_limit',
        resourceId: bucket,
        outcome: 'denied',
        reason: 'rate limit exceeded',
        metadata,
        ipAddress: input.ip,
        userAgent: input.userAgent ?? undefined,
      })
      return
    }
    // Unauthenticated route: no caller org/actor exists yet, so emit under
    // the synthetic system org (the hash chain accepts any org id).
    try {
      await writeAuditEntry(this.prisma, {
        organizationId:
          input.session?.organizationId ?? SYSTEM_AUDIT_ORG_ID,
        actorType: input.session ? 'user' : 'system',
        actorId: input.session?.userId ?? 'rate-limiter',
        action: 'auth.rate_limit.lockout',
        resourceType: 'rate_limit',
        resourceId: bucket,
        outcome: 'denied',
        reason: 'rate limit exceeded',
        metadata,
        requestId: randomUUID(),
        ipAddress: input.ip,
        userAgent: input.userAgent,
      })
    } catch (error) {
      // Never let audit emission take the limiter down with it.
      this.logger.error(
        `[rate-limit] failed to emit lockout audit event: ${String(error)}`,
      )
    }
  }
}

/** Shared factory so every wiring site (index.ts, MCP shim, tests) builds the limiter the same way. */
export const createRateLimiter = (
  prisma: PrismaClient,
  logger?: RateLimitLogger,
): RateLimiter => new RateLimiter(prisma, logger)
