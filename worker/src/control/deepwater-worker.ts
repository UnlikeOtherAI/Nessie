import type { PrismaClient } from '@prisma/client'
import { withSweepLock, type SweepLockPool } from '@nessie/db'
import {
  claimDueDeepWaterWatchRuns,
  findUnconfirmedDeepWaterBriefs,
  readDeepWaterBriefRun,
  reapUnconfirmedDeepWaterBrief,
  refreshDeepWaterRunIdentity,
  type FileService,
  type LedgerIdentityService,
  type PgQueueProvider,
} from '@nessie/runtime'
import {
  DEEP_WATER_RUN_DELIVER_TOPIC,
  DEEP_WATER_RUN_WATCH_TOPIC,
  DeepWaterRunDeliverJobPayloadSchema,
  DeepWaterRunWatchJobPayloadSchema,
} from '@nessie/schemas'

import { startUnconfirmedKickoff, startUnconfirmedNotice } from './deepwater-copy.js'
import { deepWaterTopicPreview, postDeepWaterNotice } from './deepwater-messages.js'
import { wakeDeepWaterAgent } from './deepwater-wake.js'
import { runDeepWaterWatch, watchDeepWaterRun, type DeepWaterWatchDeps } from './deepwater-watch.js'

/**
 * The worker side of DeepWater research briefs: the watch sweep that claims
 * open runs every few seconds (Water plan amendments-fable F1), the reap of
 * briefs Ledger never confirmed (N5a), and the jobs they enqueue. Each sweep
 * runs under its own advisory lock, so one replica claims at a time; the
 * claim itself is `FOR UPDATE SKIP LOCKED`, so even two would not collide.
 */

/** How often due runs are claimed: the fastest watch cadence (F1). */
const WATCH_SWEEP_MS = 5_000

/** How often briefs Ledger never confirmed are looked for (N5). */
const REAP_SWEEP_MS = 10 * 60_000

const CLAIM_BATCH = 50

export type DeepWaterWorkerDeps = {
  abortSignal: AbortSignal
  fileService: Pick<FileService, 'store' | 'delete' | 'openStream'>
  ledgerIdentity: LedgerIdentityService | null
  embeddingModel: string | null
  pool: SweepLockPool
  prisma: PrismaClient
  subscribe: PgQueueProvider['subscribe']
}

/**
 * Give up one brief Ledger never confirmed, telling whoever asked: the agent,
 * woken once, or the person (and the agent's person when the agent cannot be
 * reached). Everything commits with the reap.
 */
const reapOne = async (deps: DeepWaterWatchDeps, target: { organizationId: string; runId: string }): Promise<void> => {
  await deps.prisma.$transaction(async (tx) => {
    const run = await reapUnconfirmedDeepWaterBrief(tx, target)
    if (!run) return
    const topic = deepWaterTopicPreview(run)
    if (run.originKind === 'agent' && run.originAgentId) {
      const wake = await wakeDeepWaterAgent(tx, run, {
        agentId: run.originAgentId,
        kind: 'start_unconfirmed',
        turnId: null,
        content: startUnconfirmedKickoff(topic),
      })
      if (wake.kind !== 'unreachable') return
      console.warn(`[deep-water] wake unreachable (${wake.reason}) for reaped run ${run.id}`)
    }
    await postDeepWaterNotice(tx, run, { kind: 'start_unconfirmed', content: startUnconfirmedNotice(topic) })
  })
}

/** One pass of the reap: every brief DeepWater never confirmed within the window. */
export const reapUnconfirmedDeepWaterBriefs = async (deps: DeepWaterWatchDeps, limit = CLAIM_BATCH): Promise<void> => {
  for (const target of await findUnconfirmedDeepWaterBriefs(deps.prisma, { limit })) {
    await reapOne(deps, target)
  }
}

export const startDeepWaterWorker = (deps: DeepWaterWorkerDeps): { stop: () => void } => {
  const callDeps: DeepWaterWatchDeps = {
    prisma: deps.prisma,
    ledgerIdentity: deps.ledgerIdentity,
    fileService: deps.fileService,
    embeddingModel: deps.embeddingModel,
  }

  deps.subscribe(
    DEEP_WATER_RUN_WATCH_TOPIC,
    async (job) => runDeepWaterWatch(callDeps, DeepWaterRunWatchJobPayloadSchema.parse(job.payload)),
    { signal: deps.abortSignal },
  )

  // A person retrying a blocked delivery: renew the captured identity from
  // their live session (same person, organisation and team only), then read
  // the research and deliver it as the watch would.
  deps.subscribe(
    DEEP_WATER_RUN_DELIVER_TOPIC,
    async (job) => {
      const payload = DeepWaterRunDeliverJobPayloadSchema.parse(job.payload)
      const identity = payload.identity
      if (identity) {
        await deps.prisma.$transaction((tx) => refreshDeepWaterRunIdentity(tx, {
          organizationId: payload.organizationId,
          runId: payload.runId,
          identity,
        }))
      }
      const run = await readDeepWaterBriefRun(deps.prisma, payload)
      if (run) await watchDeepWaterRun(callDeps, run)
    },
    { signal: deps.abortSignal },
  )

  const watchTimer = setInterval(() => {
    if (deps.abortSignal.aborted) return
    void withSweepLock(deps.pool, 'deep-water-watch', () =>
      deps.prisma.$transaction((tx) => claimDueDeepWaterWatchRuns(tx, { limit: CLAIM_BATCH })))
      .catch((error: unknown) => console.error('[worker.deep-water-watch] failed', error))
  }, WATCH_SWEEP_MS)
  watchTimer.unref()

  const reapTimer = setInterval(() => {
    if (deps.abortSignal.aborted) return
    void withSweepLock(deps.pool, 'deep-water-reap', () => reapUnconfirmedDeepWaterBriefs(callDeps))
      .catch((error: unknown) => console.error('[worker.deep-water-reap] failed', error))
  }, REAP_SWEEP_MS)
  reapTimer.unref()

  return {
    stop: () => {
      clearInterval(watchTimer)
      clearInterval(reapTimer)
    },
  }
}
