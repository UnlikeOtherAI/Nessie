import type { PrismaClient } from '@prisma/client'
import { withSweepLock, type SweepLockPool } from '@nessie/db'
import {
  claimDueDeepWaterWatchRuns,
  findUnconfirmedDeepWaterBriefs,
  readDeepWaterBriefRun,
  reapUnconfirmedDeepWaterBrief,
  type FileService,
  type LedgerIdentityService,
  type PgQueueProvider,
} from '@nessie/runtime'
import {
  DEEP_WATER_RUN_DELIVER_TOPIC,
  DEEP_WATER_RUN_WATCH_TOPIC,
  DEEP_WATER_START_IDENTITY_CHANGED,
  DeepWaterRunDeliverJobPayloadSchema,
  DeepWaterRunWatchJobPayloadSchema,
  type DeepWaterRunDeliverJobPayload,
} from '@nessie/schemas'

import { runDeepWaterTransaction, type DeepWaterRealtime } from './deepwater-announce.js'
import { startIdentityChangedNotice, startUnconfirmedKickoff, startUnconfirmedNotice } from './deepwater-copy.js'
import { renewDeepWaterIdentity } from './deepwater-delivery.js'
import { deepWaterTopicPreview, postDeepWaterNotice } from './deepwater-messages.js'
import { restoreDeepWaterReportPage } from './deepwater-report-import.js'
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
  realtime: DeepWaterRealtime
  subscribe: PgQueueProvider['subscribe']
}

/**
 * Give up one brief Ledger never confirmed, telling whoever asked: the agent,
 * woken once, or the person (and the agent's person when the agent cannot be
 * reached). A brief its requester's changed sign-in stopped is told to them
 * alone, as that: waking the agent would run it with the sign-in UOA refused.
 * Everything commits with the reap.
 */
const reapOne = async (deps: DeepWaterWatchDeps, target: { organizationId: string; runId: string }): Promise<void> => {
  await runDeepWaterTransaction(deps, async (tx, announce) => {
    const run = await reapUnconfirmedDeepWaterBrief(tx, target)
    if (!run) return
    announce.run(run)
    const topic = deepWaterTopicPreview(run)
    if (run.failureCode === DEEP_WATER_START_IDENTITY_CHANGED) {
      const told = await postDeepWaterNotice(tx, announce, run, {
        kind: 'start_identity_changed',
        content: startIdentityChangedNotice({ topic, agentOrigin: run.originKind === 'agent' }),
      })
      if (!told) console.warn(`[deep-water] reaped run ${run.id}: nowhere left to tell its requester`)
      return
    }
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
    await postDeepWaterNotice(tx, announce, run, { kind: 'start_unconfirmed', content: startUnconfirmedNotice(topic) })
  })
}

/**
 * A person retrying a blocked delivery (`deep_water.run.deliver`): renew the
 * captured identity from their live session (same person, organisation and
 * team only), put back the run's own report page if it was deleted or changed
 * in Documents — the one block the retry itself must undo — then read the
 * research and deliver it as the watch would.
 */
export const retryDeepWaterDelivery = async (
  deps: DeepWaterWatchDeps,
  payload: DeepWaterRunDeliverJobPayload,
): Promise<void> => {
  const { identity } = payload
  if (identity) {
    await renewDeepWaterIdentity(deps, { organizationId: payload.organizationId, runId: payload.runId, identity })
  }
  const run = await readDeepWaterBriefRun(deps.prisma, payload)
  if (!run) return
  // Only a person's own retry puts a page back; the watch never undoes a deletion.
  if (identity) await restoreDeepWaterReportPage(deps.prisma, run)
  await watchDeepWaterRun(deps, run)
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
    realtime: deps.realtime,
  }

  deps.subscribe(
    DEEP_WATER_RUN_WATCH_TOPIC,
    async (job) => runDeepWaterWatch(callDeps, DeepWaterRunWatchJobPayloadSchema.parse(job.payload)),
    { signal: deps.abortSignal },
  )

  deps.subscribe(
    DEEP_WATER_RUN_DELIVER_TOPIC,
    async (job) => retryDeepWaterDelivery(callDeps, DeepWaterRunDeliverJobPayloadSchema.parse(job.payload)),
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
