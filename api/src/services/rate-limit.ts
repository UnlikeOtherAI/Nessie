import { randomUUID } from 'node:crypto'
import { isIPv6 } from 'node:net'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  countRateLimitHit,
  pruneRateLimitWindows,
  rateLimitKeyHash,
  writeAuditEntry,
} from '@nessie/db'
import { emitAuditEvent } from './audit.js'

/**
 * Brute-force protection for auth-sensitive endpoints (issue #211).
 *
 * The counter store itself is shared: `countRateLimitHit` in `@nessie/db`
 * (`rate-limit-window.ts`) owns the `rate_limit_buckets` statement, so this
 * limiter and the worker's outbound UOA pacer move the same rows with the same
 * SQL instead of drifting apart. One `rate_limit_buckets` row per (bucket,
 * identity hash, window start), incremented atomically so concurrent replicas
 * count against the same row; expired rows are deleted by the probabilistic
 * cleanup below. The rationale for a fixed window over a sliding log lives on
 * the shared module.
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

/**
 * Expand an IPv6 address to its eight zero-padded hextets. Input is already
 * validated by `isIPv6`, so this only handles `::` compression and an
 * embedded IPv4 tail (`::ffff:192.0.2.1`); any zone id (`%eth0`) is dropped.
 */
const expandIPv6Hextets = (ip: string): string[] => {
  let addr = ip.toLowerCase().split('%', 1)[0] ?? ''
  if (addr.includes('.')) {
    const octets = addr
      .slice(addr.lastIndexOf(':') + 1)
      .split('.')
      .map((part) => Number.parseInt(part, 10))
    addr = `${addr.slice(0, addr.lastIndexOf(':'))}:${
      (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)
    }:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`
  }
  const [head = '', tail = ''] = addr.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === '' ? [] : tail.split(':')
  const fill = 8 - headParts.length - tailParts.length
  return [
    ...headParts,
    ...Array.from({ length: Math.max(fill, 0) }, () => '0'),
    ...tailParts,
  ].map((part) => part.padStart(4, '0'))
}

/**
 * Canonicalize an IP identity before it is hashed into a bucket key: IPv6
 * collapses to its /64 prefix (the smallest routed allocation — an attacker
 * with a /64 otherwise rotates through 2^64 fresh counters), IPv4 is
 * unchanged and stays per-address.
 */
const canonicalizeIpIdentity = (ip: string): string => {
  if (!isIPv6(ip)) return ip
  return `${expandIPv6Hextets(ip).slice(0, 4).join(':')}::/64`
}

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
    /** Fraction of hits that sweep expired rows; 1.0 makes cleanup deterministic in tests. */
    private readonly cleanupProbability: number = CLEANUP_PROBABILITY,
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
   * `ip:<addr>` (IPv6 canonicalized to its /64 prefix by the caller — see
   * `canonicalizeIpIdentity`) so they can never collide with account ids.
   */
  async check(
    bucket: string,
    rule: RateLimitRule,
    identity: string,
  ): Promise<RateLimitDecision> {
    this.stats.checks += 1
    const now = Date.now()
    try {
      const hit = await countRateLimitHit(this.prisma, {
        bucket,
        keyHash: rateLimitKeyHash(bucket, identity),
        nowMs: now,
        rule,
      })
      // Bounded cleanup: 2% of hits sweep expired rows, keeping the table at
      // ~live keys per window without a background job. The sweep is scoped
      // to the triggering bucket: other buckets run on different windows, so
      // their still-live rows must never be deleted here.
      if (Math.random() < this.cleanupProbability) {
        await pruneRateLimitWindows(this.prisma, {
          before: new Date(now - rule.windowMs),
          bucket,
        })
      }
      if (hit.limited) {
        this.stats.limited += 1
        this.stats.limitedByBucket.set(
          bucket,
          (this.stats.limitedByBucket.get(bucket) ?? 0) + 1,
        )
      }
      return {
        limited: hit.limited,
        bucket,
        count: hit.count,
        limit: rule.max,
        retryAfterSeconds: hit.retryAfterSeconds,
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
      `ip:${canonicalizeIpIdentity(input.ip)}`,
    )
    let accountDecision: RateLimitDecision | null = null
    if (input.rules.account && input.accountIdentity) {
      accountDecision = await this.check(
        input.rules.account.bucket,
        input.rules.account.rule,
        `account:${input.accountIdentity}`,
      )
    }

    const decisions = [ipDecision, accountDecision].filter(
      (decision): decision is RateLimitDecision => decision !== null,
    )
    const tripped = decisions.find((decision) => decision.limited)
    if (!tripped) {
      return { allowed: true }
    }

    // Audit only the lockout TRANSITION — the hit that pushes a bucket's
    // counter to exactly max + 1 (per bucket, per window). Requests rejected
    // while the bucket is already locked out emit nothing: unauthenticated
    // events serialize on the zero-org audit advisory lock, so emitting per
    // rejected request would make a flood of rejections costlier than
    // acceptances and drown the audit table.
    if (decisions.some((decision) => decision.count === decision.limit + 1)) {
      await this.emitLockoutEvent({
        decisions,
        ip: input.ip,
        auditContext: input.auditContext ?? null,
        session: input.session ?? null,
        userAgent: input.userAgent ?? null,
      })
    }

    const retryAfterSeconds = Math.max(
      ...decisions
        .filter((decision) => decision.limited)
        .map((decision) => decision.retryAfterSeconds),
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
      ipHash: rateLimitKeyHash('audit.ip', input.ip),
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
