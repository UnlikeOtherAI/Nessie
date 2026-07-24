import type { PrismaClient } from '@prisma/client'
import type {
  OpsHealthResponse,
  ReadinessResponse,
  WorkerHealthStatus,
} from '../contracts.js'
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

// NOTE ON TENANCY: queue_jobs and execution_runners have no per-tenant column —
// they are deployment-wide infrastructure. The queue counts, worker health, and
// dead-job rows below are therefore deployment-global (surfaced to org owners as an
// operations view), while dead-letter mailbox data IS org-scoped. A future
// platform-admin role should gate the deployment-global parts; until then we cap the
// dead-job error text so it cannot dump arbitrary cross-tenant payload data.
export const getOpsHealth = async (
  prisma: PrismaClient,
  organizationId: string,
  rateLimiter?: RateLimiter,
): Promise<OpsHealthResponse> => {
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
    rateLimit: rateLimiter?.snapshot() ?? {
      checks: 0,
      limited: 0,
      storeErrors: 0,
      limitedByBucket: {},
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
