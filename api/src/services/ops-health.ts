import type { PrismaClient } from '@prisma/client'
import type { NessieConfig } from '@nessie/config'
import type {
  OpsHealthResponse,
  OpsRateLimit,
  ReadinessResponse,
  WorkerHealthStatus,
} from '../contracts/ops-budget.js'
import { RATE_LIMIT_BUCKETS, rateLimitForRules } from '../routes/auth-rate-limit.js'
import type { RateLimiter } from './rate-limit.js'

// The worker refreshes heartbeatAt on its runner rows every 30s (worker/src/index.ts
// -> registerExecutionRunners), unconditionally — it writes heartbeatAt on every
// upsert regardless of whether a provider (docker/gcloud) probe succeeds; only the
// runner's `status` reflects provider availability. So heartbeat *recency* is the
// true worker-process-liveness signal, while `status='active'` only means an
// execution provider is reachable. Liveness must key off recency, NOT status.
const WORKER_UP_THRESHOLD_MS = 90_000 // 3 missed beats
const WORKER_STALE_THRESHOLD_MS = 5 * 60_000

// errorMessage is the raw exception text persisted by the queue and may embed job
// payload fragments; cap it before returning so a dead job cannot dump arbitrary data.
const ERROR_MESSAGE_MAX = 500

const QUEUE_STATUSES = ['pending', 'processing', 'done', 'dead'] as const

const computeWorkerStatus = (
  lastHeartbeatAt: Date | null,
  runnerCount: number,
): WorkerHealthStatus => {
  if (!lastHeartbeatAt || runnerCount === 0) return 'down'
  const ageMs = Date.now() - lastHeartbeatAt.getTime()
  if (ageMs <= WORKER_UP_THRESHOLD_MS) return 'up'
  if (ageMs <= WORKER_STALE_THRESHOLD_MS) return 'stale'
  return 'down'
}

export const getWorkerHealth = async (prisma: PrismaClient) => {
  const runners = await prisma.executionRunner.findMany({
    select: { heartbeatAt: true, status: true },
    orderBy: { heartbeatAt: 'desc' },
  })

  const lastHeartbeatAt = runners[0]?.heartbeatAt ?? null
  // Liveness from heartbeat recency across ALL runners; activeRunners is reported
  // separately as a provider-availability metric, not as the liveness gate.
  const status = computeWorkerStatus(lastHeartbeatAt, runners.length)
  const activeRunners = runners.filter((runner) => runner.status === 'active').length
  const heartbeatAgeSeconds = lastHeartbeatAt
    ? Math.round((Date.now() - lastHeartbeatAt.getTime()) / 1000)
    : null

  return {
    status,
    activeRunners,
    lastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null,
    heartbeatAgeSeconds,
  }
}

const getQueueCounts = async (prisma: PrismaClient) => {
  const grouped = await prisma.queueJob.groupBy({
    by: ['status'],
    _count: { _all: true },
  })

  const counts: Record<(typeof QUEUE_STATUSES)[number], number> = {
    pending: 0,
    processing: 0,
    done: 0,
    dead: 0,
  }
  for (const row of grouped) {
    if ((QUEUE_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as (typeof QUEUE_STATUSES)[number]] = row._count._all
    }
  }
  return counts
}

/**
 * A quiet limiter is the common case and it is not interesting: with 24 buckets
 * and most of them idle, listing every one buries the two that are counting.
 * Only buckets with traffic in their current window are returned, ordered by
 * lockouts first and volume second, so the row an operator needs during an
 * incident is the first one.
 */
const activeRateLimitBuckets = (
  summaries: Awaited<ReturnType<RateLimiter['windowSummary']>>,
): OpsRateLimit['deploymentWide']['buckets'] =>
  (summaries ?? [])
    .filter((summary) => summary.hits > 0)
    .sort((left, right) =>
      right.limitedIdentities - left.limitedIdentities || right.hits - left.hits)
    .map((summary) => ({
      bucket: summary.bucket,
      hits: summary.hits,
      identities: summary.identities,
      limit: summary.limit,
      limitedIdentities: summary.limitedIdentities,
      maxCount: summary.maxCount,
      windowMs: summary.windowMs,
      windowStartedAt: new Date(summary.windowStartMs).toISOString(),
    }))

/**
 * Every bucket the API counts into, paired with its configured rule.
 *
 * `RATE_LIMIT_BUCKETS` is already the compile-checked list of limiter names and
 * `rateLimitForRules` is already the one bucket→rule pairing, so a limiter added
 * to the deployment appears on this page without anybody remembering to add it
 * here — and a bucket that lost its rule is a compile error there, not a silent
 * gap here.
 */
const configuredRateLimitRules = (config: NessieConfig) =>
  (Object.keys(RATE_LIMIT_BUCKETS) as Array<keyof typeof RATE_LIMIT_BUCKETS>)
    .map((name) => rateLimitForRules(config.api.rateLimit, name))
    // A bucket with no rule cannot have a window read for it, and a health
    // endpoint is the last place that should throw on a partial config. The
    // type says this cannot happen and the pairing above is compile-checked;
    // the filter is here so a hand-built config in a test or a shim degrades to
    // a missing row rather than a 500.
    .filter((entry) => Boolean(entry.rule))

/** What a caller with no limiter reports for itself: nothing, honestly zero. */
const emptyInstanceStats = (): OpsRateLimit['thisInstance'] => ({
  bootedAt: new Date(0).toISOString(),
  checks: 0,
  limited: 0,
  storeErrors: 0,
  limitedByBucket: {},
})

// NOTE ON TENANCY: queue_jobs and execution_runners have no per-tenant column —
// they are deployment-wide infrastructure. The queue counts, worker health, and
// dead-job rows below are therefore deployment-global, while dead-letter mailbox
// data IS org-scoped. The platform-admin role this note used to ask for now
// exists and gates the route: `GET /api/ops/health` requires `User.superAdmin`
// (`routes/health.ts`), not an org owner. The dead-job error text stays capped
// regardless, so one caller's view can never dump arbitrary payload data.
export const getOpsHealth = async (
  prisma: PrismaClient,
  organizationId: string,
  rateLimiter?: RateLimiter,
  /**
   * Needed only to know which buckets exist and what each one's limit is; the
   * counts themselves come from `rate_limit_buckets`. Omitted (a caller that
   * has no config to hand) means no bucket list, so no deployment-wide read.
   */
  config?: NessieConfig,
): Promise<OpsHealthResponse> => {
  const rateLimitSummaries = rateLimiter && config
    ? await rateLimiter.windowSummary(configuredRateLimitRules(config))
    : null
  const [worker, queue, deadJobRows, deadLetterCount, deadLetterRows] = await Promise.all([
    getWorkerHealth(prisma),
    getQueueCounts(prisma),
    prisma.queueJob.findMany({
      where: { status: 'dead' },
      orderBy: { enqueuedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        topic: true,
        attempt: true,
        maxAttempts: true,
        errorMessage: true,
        enqueuedAt: true,
      },
    }),
    prisma.agentMailboxMessage.count({
      where: { organizationId, status: 'dead_letter' },
    }),
    prisma.agentMailboxMessage.findMany({
      where: { organizationId, status: 'dead_letter' },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: { id: true, subject: true, attempts: true, createdAt: true },
    }),
  ])

  return {
    worker,
    queue,
    deadJobs: deadJobRows.map((job) => ({
      id: job.id,
      topic: job.topic,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      errorMessage: job.errorMessage ? job.errorMessage.slice(0, ERROR_MESSAGE_MAX) : null,
      enqueuedAt: job.enqueuedAt.toISOString(),
    })),
    deadLetters: {
      count: deadLetterCount,
      recent: deadLetterRows.map((message) => ({
        id: message.id,
        subject: message.subject,
        attempts: message.attempts,
        createdAt: message.createdAt.toISOString(),
      })),
    },
    rateLimit: {
      deploymentWide: {
        available: rateLimitSummaries !== null,
        buckets: activeRateLimitBuckets(rateLimitSummaries),
        source: 'rate_limit_buckets',
      },
      thisInstance: rateLimiter?.snapshot() ?? emptyInstanceStats(),
    },
  }
}

export const getReadiness = async (
  prisma: PrismaClient,
): Promise<ReadinessResponse> => {
  let database = false
  try {
    await prisma.$queryRaw`SELECT 1`
    database = true
  } catch {
    database = false
  }

  const worker = await getWorkerHealth(prisma).catch(() => null)
  const workerStatus: WorkerHealthStatus = worker?.status ?? 'down'

  return {
    ready: database && workerStatus !== 'down',
    checks: { database, worker: workerStatus },
  }
}
