/**
 * W26 — installation overlap policy (workflows-first-class plan §6).
 *
 * `WorkflowInstallation.concurrency` holds
 * `{ limit: 1, onOverlap: 'skip' | 'queue' | 'parallel' }`, defaulting to
 * `{ limit: 1, onOverlap: 'skip' }`. The policy is enforced under a
 * per-installation advisory lock at EVERY run-creation entrypoint (manual,
 * scheduled, webhook, event, retry, continuation), not only in the trigger
 * path — otherwise it is trivially bypassed.
 *
 * - `skip`: an active run at capacity withholds the execute job and the
 *   admission is recorded (`skipped_overlap` on the run summary; a trigger
 *   fire additionally marks its delivery `skipped`) so silent skips stay
 *   diagnosable.
 * - `queue`: same withholding, but the run stays `pending` and the active
 *   run's terminal transition releases the next one — bounded by
 *   {@link WORKFLOW_OVERLAP_QUEUE_DEPTH_LIMIT}, beyond which the fire skips.
 * - `parallel`: opt-in for stateless workflows; only the (high) global limit
 *   applies.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

export type WorkflowOverlapPolicy = 'parallel' | 'queue' | 'skip'

export type WorkflowConcurrencyConfig = {
  limit: number
  onOverlap: WorkflowOverlapPolicy
}

export const DEFAULT_WORKFLOW_CONCURRENCY: WorkflowConcurrencyConfig = {
  limit: 1,
  onOverlap: 'skip',
}

export const WORKFLOW_OVERLAP_QUEUE_DEPTH_LIMIT = 10

export const WORKFLOW_OVERLAP_SKIP_REASON = 'skipped_overlap'

const OVERLAP_POLICIES: ReadonlySet<string> = new Set(['parallel', 'queue', 'skip'])

export const parseWorkflowConcurrency = (value: unknown): WorkflowConcurrencyConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_WORKFLOW_CONCURRENCY
  }
  const record = value as Record<string, unknown>
  const limit =
    typeof record['limit'] === 'number' &&
    Number.isInteger(record['limit']) &&
    record['limit'] >= 1
      ? Math.min(record['limit'], 100)
      : DEFAULT_WORKFLOW_CONCURRENCY.limit
  const onOverlap =
    typeof record['onOverlap'] === 'string' && OVERLAP_POLICIES.has(record['onOverlap'])
      ? (record['onOverlap'] as WorkflowOverlapPolicy)
      : DEFAULT_WORKFLOW_CONCURRENCY.onOverlap
  return { limit, onOverlap }
}

export const isWorkflowConcurrencyConfig = (
  value: unknown,
): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (((value as Record<string, unknown>)['limit'] === undefined ||
    (typeof (value as Record<string, unknown>)['limit'] === 'number' &&
      Number.isInteger((value as Record<string, unknown>)['limit']) &&
      ((value as Record<string, unknown>)['limit'] as number) >= 1)) &&
    ((value as Record<string, unknown>)['onOverlap'] === undefined ||
      OVERLAP_POLICIES.has((value as Record<string, unknown>)['onOverlap'] as string)))

type PrismaLike = PrismaClient | Prisma.TransactionClient

const withTransaction = async <T>(
  prisma: PrismaLike,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if ('$transaction' in prisma) {
    return prisma.$transaction((tx) => work(tx))
  }
  return work(prisma as Prisma.TransactionClient)
}

/**
 * Lock the installation's overlap slot for the duration of `work`. Every
 * run-admission decision must read active-run counts through this, or two
 * concurrent fires both see an empty slot.
 */
export const withWorkflowOverlapLock = async <T>(
  prisma: PrismaLike,
  installationId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> =>
  withTransaction(prisma, async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${installationId}),
        hashtext('workflow_overlap')
      )
    `
    return work(tx)
  })

export type WorkflowOverlapAdmission =
  | { kind: 'admit' }
  | { kind: 'withhold'; policy: 'queue' }
  | { kind: 'skip' }

/**
 * The admission decision, made inside {@link withWorkflowOverlapLock}.
 * `skip` on a queued-depth breach converts to a plain skip — a stalled
 * installation must not accumulate unbounded pending work.
 */
export const admitWorkflowRunUnderOverlap = async (
  tx: Prisma.TransactionClient,
  input: {
    concurrency: WorkflowConcurrencyConfig
    installationId: string
  },
): Promise<WorkflowOverlapAdmission> => {
  const { concurrency } = input

  const active = await tx.workflowRun.count({
    where: {
      installationId: input.installationId,
      status: 'running',
    },
  })

  const effectivePolicy =
    concurrency.onOverlap === 'parallel'
      ? ('parallel' as const)
      : concurrency.onOverlap

  if (effectivePolicy === 'parallel' || active < concurrency.limit) {
    return { kind: 'admit' }
  }

  if (effectivePolicy === 'skip') {
    return { kind: 'skip' }
  }

  const withheld = await tx.workflowRun.count({
    where: {
      installationId: input.installationId,
      status: 'pending',
      startedAt: null,
      summary: { startsWith: `${WORKFLOW_OVERLAP_SKIP_REASON}:` },
    },
  })
  return withheld < WORKFLOW_OVERLAP_QUEUE_DEPTH_LIMIT
    ? { kind: 'withhold', policy: 'queue' }
    : { kind: 'skip' }
}

/**
 * Release at most one withheld pending run once the just-terminalized run
 * frees the installation's slot. Returns the released run id so the caller
 * can enqueue its execute job inside the same transaction. Already-safe to
 * call for non-queue installations (they never withhold).
 */
export const releaseNextQueuedWorkflowRun = async (
  tx: Prisma.TransactionClient,
  installationId: string,
): Promise<{ id: string } | null> => {
  const installation = await tx.workflowInstallation.findUnique({
    where: { id: installationId },
    select: { concurrency: true },
  })
  const concurrency = parseWorkflowConcurrency(installation?.concurrency)
  if (concurrency.onOverlap !== 'queue') {
    return null
  }

  const active = await tx.workflowRun.count({
    where: { installationId, status: 'running' },
  })
  if (active >= concurrency.limit) {
    return null
  }

  const next = await tx.workflowRun.findFirst({
    where: {
      installationId,
      status: 'pending',
      startedAt: null,
      summary: { startsWith: `${WORKFLOW_OVERLAP_SKIP_REASON}:` },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  if (!next) {
    return null
  }

  const claimed = await tx.workflowRun.updateMany({
    where: { id: next.id, status: 'pending', startedAt: null },
    data: { summary: null },
  })
  return claimed.count > 0 ? next : null
}
