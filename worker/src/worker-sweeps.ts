import { withSweepLock } from '@nessie/db'
import { expireDeadQueueJobs } from '@nessie/runtime'
import { DASHBOARD_REFRESH_TOPIC } from '@nessie/dashboard'
import {
  BOARD_SOURCE_WEBHOOKS_RENEW_TOPIC,
} from '@nessie/schemas'
import { sweepSettledBudgetReservations } from './control/budget-reservation-sweep.js'
import {
  PUSH_SEND_CLAIM_SWEEP_INTERVAL_MS,
  sweepExpiredPushSendClaims,
} from './control/push-claim-sweep.js'
import { sweepDueGmailSends } from './control/gmail-send-sweep.js'
import {
  DOCUMENT_SESSION_REAP_INTERVAL_MS,
  DOCUMENT_SESSION_REAP_LOCK,
  reapAbandonedDocumentSessions,
} from './control/document-session-reaper.js'
import {
  expireStaleControlClaims,
  reapExpiredCloudBrowserSessions,
  reconcileTombstonedAgentBrowsers,
} from '@nessie/browser-cloud'
import { sweepDueDashboardSources } from './control/dashboard-refresh.js'
import {
  REVALIDATION_SWEEP_INTERVAL_MS,
  sweepDueDomainRevalidations,
  sweepStrandedReconciliations,
} from './control/automatic-membership/revalidate.js'
import { sweepDueBoardSources } from './control/board-source-sync.js'
import { reapStuckWorkflowSteps } from './control/workflow-step-reaper.js'
import { reclaimExpiredMailboxMessages, dispatchNextMailboxMessage } from './control/mailbox.js'
import { retryFailedTriggerDeliveries, reattemptTriggerDelivery, sweepDueScheduledTriggers } from './control/triggers.js'
import {
  expireExecutionLeases,
  reapStaleExecutionRunners,
  registerExecutionRunners,
  renewExecutionLeases,
} from './control/execution.js'
import { startDeadQueueJobSweep } from './lifecycle.js'
import { sweepPendingThreadMessages } from './run/thread-serialization.js'
import { enqueueBoardSourceSync, enqueueCommsIncrementalSweep, enqueueCommsSubscriptionsRenew, enqueueQueueJob } from './queue.js'
import { listIncrementalPollingConnectors } from '@nessie/comms-connect'
import { maybeSyncRegistry } from './control/registry-sync-sweep.js'
import { sweepExpiredActiveCalls } from './control/call-lifecycle.js'
import type { WorkerSweepDeps } from './worker-runtime-types.js'

export const startWorkerSweeps = (deps: WorkerSweepDeps): { stop: () => void } => {
  const { abortSignal, automaticMembershipEnabled, cloudBrowser, pool, prisma, realtimeTransport, runnerLabelPrefix } = deps

let triggerSweepInFlight = false
const triggerSweepInterval = setInterval(async () => {
  if (triggerSweepInFlight || abortSignal.aborted) {
    return
  }

  triggerSweepInFlight = true
  try {
    await sweepDueScheduledTriggers(prisma, {
      limit: 20,
    })
  } catch (error) {
    console.error('[worker.trigger-sweep] failed', error)
  } finally {
    triggerSweepInFlight = false
  }
}, 15_000)

// The undo window only means anything if something eventually dispatches the
// held send. 5s so the wait a person sees is close to the window they were
// promised, not the window plus a sweep tick.
let gmailSendSweepInFlight = false
const gmailSendSweepInterval = setInterval(async () => {
  if (gmailSendSweepInFlight || abortSignal.aborted) return
  const encryptionSecret = process.env.NESSIE_AUTH_SECRET
  if (!encryptionSecret) return
  gmailSendSweepInFlight = true
  try {
    await sweepDueGmailSends(prisma, { encryptionSecret })
  } catch (error) {
    console.error('[worker.gmail-send-sweep] failed', error)
  } finally {
    gmailSendSweepInFlight = false
  }
}, 5_000)

const maxActiveCallHours = (() => {
  const configured = Number(process.env.NESSIE_CALL_MAX_ACTIVE_HOURS)
  return Number.isFinite(configured) && configured > 0 ? configured : 8
})()
let activeCallExpiryInFlight = false
const activeCallExpiryInterval = setInterval(async () => {
  if (activeCallExpiryInFlight || abortSignal.aborted) return
  activeCallExpiryInFlight = true
  try {
    await sweepExpiredActiveCalls(
      prisma,
      realtimeTransport,
      new Date(Date.now() - maxActiveCallHours * 60 * 60 * 1000),
    )
  } catch (error) {
    console.error('[worker.call-expiry] failed', error)
  } finally {
    activeCallExpiryInFlight = false
  }
}, 60_000)

// Due-source sweep. Reuses the trigger poller's claim shape rather than
// introducing a second scheduler: a conditional update on `claimedAt` means
// two workers cannot both take one source.
let dashboardSweepInFlight = false
const dashboardSweepInterval = setInterval(async () => {
  if (dashboardSweepInFlight || abortSignal.aborted) return
  dashboardSweepInFlight = true
  try {
    const claimed = await sweepDueDashboardSources(prisma, { limit: 20 })
    for (const source of claimed) {
      // One queued attempt per source: a slow fetch must not pile up.
      await enqueueQueueJob(prisma, {
        idempotencyKey: `dashboard:refresh:${source.sourceId}`,
        payload: { sourceId: source.sourceId },
        topic: DASHBOARD_REFRESH_TOPIC,
      })
    }
  } catch (error) {
    console.error('[worker.dashboard-sweep] failed', error)
  } finally {
    dashboardSweepInFlight = false
  }
}, 30_000)

// Board-source sweep. The same claim shape as the dashboard sweep above, for
// the same reason: a conditional update on `claimedAt` is what stops two
// workers syncing one source at once.
let boardSourceSweepInFlight = false
const boardSourceSweepInterval = setInterval(async () => {
  if (boardSourceSweepInFlight || abortSignal.aborted) return
  boardSourceSweepInFlight = true
  try {
    const claimed = await sweepDueBoardSources(prisma, { limit: 20 })
    for (const source of claimed) {
      await enqueueBoardSourceSync(prisma, { sourceId: source.sourceId }, source.claimedAt)
    }
    // A webhook due inside three days is renewed now. The idempotency key is
    // bucketed by day, so ticking every 30 seconds still queues one job.
    await enqueueQueueJob(prisma, {
      idempotencyKey: `board-source:webhooks-renew:${new Date().toISOString().slice(0, 10)}`,
      payload: { withinMs: 3 * 24 * 60 * 60 * 1000 },
      topic: BOARD_SOURCE_WEBHOOKS_RENEW_TOPIC,
    })
  } catch (error) {
    console.error('[worker.board-source-sweep] failed', error)
  } finally {
    boardSourceSweepInFlight = false
  }
}, 30_000)

// Automatic-membership DNS revalidation. A short tick that asks "is one
// due?", not a 24-hour timer: a long interval never fires in a deployment
// that redeploys more often than its period, and this is the control that
// catches a domain leaving the organisation's hands.
let domainRevalidationSweepInFlight = false
const domainRevalidationInterval = setInterval(async () => {
  if (domainRevalidationSweepInFlight || abortSignal.aborted) return
  domainRevalidationSweepInFlight = true
  try {
    await sweepDueDomainRevalidations(prisma, automaticMembershipEnabled)
    await sweepStrandedReconciliations(prisma, automaticMembershipEnabled)
  } catch (error) {
    console.error('[worker.automatic-membership-revalidation] failed', error)
  } finally {
    domainRevalidationSweepInFlight = false
  }
}, REVALIDATION_SWEEP_INTERVAL_MS)

// W6: reclaim stuck workflow steps — an expired lease (actively-worked step
// whose worker died) or an expired deadline (suspended step waiting on an
// external continuation). Both conditions; a lease-only sweep never reclaims
// the likeliest hangs.
let workflowStepReapInFlight = false
const workflowStepReapInterval = setInterval(async () => {
  if (workflowStepReapInFlight || abortSignal.aborted) {
    return
  }

  workflowStepReapInFlight = true
  try {
    await reapStuckWorkflowSteps(prisma, { limit: 20 })
  } catch (error) {
    console.error('[worker.workflow-step-reaper] failed', error)
  } finally {
    workflowStepReapInFlight = false
  }
}, 15_000)

// Budget reservations left by runs that finished without ever recording
// spend. Hygiene only — the admission aggregate already ignores them.
let budgetReservationSweepInFlight = false
const budgetReservationSweepInterval = setInterval(async () => {
  if (budgetReservationSweepInFlight || abortSignal.aborted) {
    return
  }

  budgetReservationSweepInFlight = true
  try {
    await sweepSettledBudgetReservations(prisma)
  } catch (error) {
    console.error('[worker.budget-reservation-sweep] failed', error)
  } finally {
    budgetReservationSweepInFlight = false
  }
}, 60_000)

// Push send claims outlive the job that took them by design — a `sent` claim
// is what stops a redelivery ringing a device twice — so nothing else ever
// removes them, and one row per notification per endpoint is tens of
// thousands a day for an active organisation. Age-based DELETE, no leader
// needed; the horizon and the reasoning are in `push-claim-sweep.ts`.
let pushClaimSweepInFlight = false
const pushClaimSweepInterval = setInterval(async () => {
  if (pushClaimSweepInFlight || abortSignal.aborted) {
    return
  }

  pushClaimSweepInFlight = true
  try {
    await sweepExpiredPushSendClaims(prisma)
  } catch (error) {
    console.error('[worker.push-claim-sweep] failed', error)
  } finally {
    pushClaimSweepInFlight = false
  }
}, PUSH_SEND_CLAIM_SWEEP_INTERVAL_MS)

// Document sessions whose producer died. Every terminaliser for
// `run_document_sessions` lives in the executing process, so a hard-killed
// worker leaves a `streaming` row nothing else ever moves: the popup spins
// for ever and the API keeps counting the document as active (audit 2.5).
// "Abandoned" is the run's executor heartbeat going silent, never age — the
// module says why, and why five minutes.
//
// Registered here rather than beside the API's maintenance sweeps, where the
// plan filed it: the API's always-on cost is what pins it to a minimum
// instance, and a fifth API sweep works against ever letting it idle. Nothing
// about the work needs the API — it reads and writes rows the worker owns.
//
// One indivisible bounded pass, so the primitive is `withSweepLock`
// (horizontal-scaling invariant 2). The body is safe to run twice regardless:
// every write is conditional on the session still being open.
let documentSessionReapInFlight = false
const documentSessionReapInterval = setInterval(() => {
  if (documentSessionReapInFlight || abortSignal.aborted) {
    return
  }

  documentSessionReapInFlight = true
  void withSweepLock(pool, DOCUMENT_SESSION_REAP_LOCK, () =>
    reapAbandonedDocumentSessions(prisma, {
      publishSse: (threadId, event, data) =>
        realtimeTransport.publishSse(threadId, event, data),
    }))
    .catch((error: unknown) => {
      console.error('[worker.document-session-reaper] failed', error)
    })
    .finally(() => {
      documentSessionReapInFlight = false
    })
}, DOCUMENT_SESSION_REAP_INTERVAL_MS)

// A run that crashed before any terminal transition, or a session that
// outlived its TTL, still costs browser-hours until somebody tells
// Browserbase to stop it. Reaping calls the provider; flipping the row alone
// would leave a browser billing with nothing pointing at it.
let cloudBrowserReapInFlight = false
const cloudBrowserReapInterval = setInterval(async () => {
  if (cloudBrowserReapInFlight || abortSignal.aborted) {
    return
  }

  cloudBrowserReapInFlight = true
  try {
    await reapExpiredCloudBrowserSessions(cloudBrowser, { limit: 20 })
    // A stale claim loses viewer authority but remains a worker-side hold
    // until somebody explicitly hands the browser back. Tombstoned contexts
    // must actually be deleted at Browserbase rather than left behind
    // holding somebody's login state.
    await expireStaleControlClaims(prisma)
    await reconcileTombstonedAgentBrowsers(cloudBrowser, { limit: 10 })
  } catch (error) {
    console.error('[worker.cloud-browser-reaper] failed', error)
  } finally {
    cloudBrowserReapInFlight = false
  }
}, 30_000)

// sp-webhook: re-attempt failed trigger deliveries that are due for retry.
let deliveryRetryInFlight = false
const deliveryRetryInterval = setInterval(async () => {
  if (deliveryRetryInFlight || abortSignal.aborted) {
    return
  }

  deliveryRetryInFlight = true
  try {
    await retryFailedTriggerDeliveries(prisma, reattemptTriggerDelivery, {
      limit: 10,
    })
  } catch (error) {
    console.error('[worker.trigger-retry] failed', error)
  } finally {
    deliveryRetryInFlight = false
  }
}, 15_000)

let mailboxSweepInFlight = false
const mailboxSweepInterval = setInterval(async () => {
  if (mailboxSweepInFlight || abortSignal.aborted) {
    return
  }

  mailboxSweepInFlight = true
  try {
    await reclaimExpiredMailboxMessages(prisma)

    let dispatched = true
    let iterations = 0
    while (dispatched && iterations < 10) {
      dispatched = await dispatchNextMailboxMessage(prisma, realtimeTransport)
      iterations += 1
    }
  } catch (error) {
    console.error('[worker.mailbox-sweep] failed', error)
  } finally {
    mailboxSweepInFlight = false
  }
}, 5_000)

const runnerHeartbeatInterval = setInterval(async () => {
  if (abortSignal.aborted) {
    return
  }

  try {
    await registerExecutionRunners(prisma, {
      labelPrefix: runnerLabelPrefix,
    })
    await renewExecutionLeases(prisma, {
      runnerLabelPrefix,
    })
  } catch (error) {
    console.error('[worker.execution-runners] heartbeat failed', error)
  }
}, 30_000)

const executionLeaseSweepInterval = setInterval(async () => {
  if (abortSignal.aborted) {
    return
  }

  try {
    await expireExecutionLeases(prisma)
    // Ordered after the expiry on purpose: a runner is only collectable once
    // its leases are terminal, so expiring first is what lets the next pass
    // take the runner an hour-dead process left behind.
    await reapStaleExecutionRunners(prisma)
  } catch (error) {
    console.error('[worker.execution-leases] reconcile failed', error)
  }
}, 15_000)

const deadQueueSweepInterval = startDeadQueueJobSweep(() => expireDeadQueueJobs(pool))

// Re-poll for pended thread messages whose in-flight run vanished without
// draining (worker crash between terminal update and drain, or an API-side
// cancel of a queued run): enqueue their batched follow-up run.
let pendingBatchSweepInFlight = false
const pendingBatchSweepInterval = setInterval(async () => {
  if (pendingBatchSweepInFlight || abortSignal.aborted) {
    return
  }

  pendingBatchSweepInFlight = true
  try {
    await sweepPendingThreadMessages(prisma, { limit: 20 })
  } catch (error) {
    console.error('[worker.pending-batch-sweep] failed', error)
  } finally {
    pendingBatchSweepInFlight = false
  }
}, 10_000)

// Enqueue the communications subscription-renewal sweep on a fixed cadence.
// The idempotency key is bucketed to the interval so multiple worker replicas
// ticking together enqueue at most one sweep per window.
const COMMS_RENEW_INTERVAL_MS = 5 * 60 * 1000
const commsRenewInterval = setInterval(async () => {
  if (abortSignal.aborted) {
    return
  }

  try {
    const bucket = Math.floor(Date.now() / COMMS_RENEW_INTERVAL_MS)
    await enqueueCommsSubscriptionsRenew(
      prisma,
      {},
      `comms-subscriptions-renew:${bucket}`,
    )
  } catch (error) {
    console.error('[worker.comms-renew] enqueue failed', error)
  }
}, COMMS_RENEW_INTERVAL_MS)

// Explicit connector opt-in keeps webhook-backed providers out of this
// reconciliation path; distinct per-provider buckets honour their cadence.
const COMMS_INCREMENTAL_SWEEP_INTERVAL_MS = 60 * 1000
const commsIncrementalSweepInterval = setInterval(async () => {
  if (abortSignal.aborted) return
  try {
    const now = Date.now()
    for (const polling of listIncrementalPollingConnectors()) {
      const bucket = Math.floor(now / polling.intervalMs)
      await enqueueCommsIncrementalSweep(
        prisma,
        { provider: polling.provider, bucket },
        `comms-incremental-sweep:${polling.provider}:${bucket}:start`,
      )
    }
  } catch (error) {
    console.error('[worker.comms-incremental-sweep] enqueue failed', error)
  }
}, COMMS_INCREMENTAL_SWEEP_INTERVAL_MS)

// Apps catalogue registry sync. `maybeSyncRegistry` takes the
// `mcp-registry-sync` advisory lock — a session lock on a connection out of
// the pool below, held for the whole walk — and self-gates on the last
// completed run
// (6h window, `NESSIE_REGISTRY_SYNC_INTERVAL_MS`), so a restart or a frequent
// poll never triggers a fresh multi-minute walk — the poll only asks "is one
// due?". The lock is what makes that decision cluster-wide, so there is
// nothing left for this file to guard, and no post-startup kick: every
// replica firing one 60 s after boot was N walks per scale-out (audit 5.9),
// and an empty store is filled by the first tick instead.
//
// Guard a bad env value: an unparseable NESSIE_REGISTRY_SYNC_SWEEP_MS would
// otherwise become a NaN delay (a hot 1ms loop), so fall back to 30 minutes.
const registrySyncSweepMs = (() => {
  const fromEnv = Number(process.env.NESSIE_REGISTRY_SYNC_SWEEP_MS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30 * 60 * 1000
})()
const registrySyncSweepInterval = setInterval(() => {
  void maybeSyncRegistry(prisma, pool).catch((error: unknown) => {
    console.error('[worker.registry-sync] failed', error)
  })
}, registrySyncSweepMs)

  return {
    stop: () => {
      clearInterval(triggerSweepInterval)
      clearInterval(gmailSendSweepInterval)
      clearInterval(activeCallExpiryInterval)
      clearInterval(dashboardSweepInterval)
      clearInterval(boardSourceSweepInterval)
      clearInterval(domainRevalidationInterval)
      clearInterval(workflowStepReapInterval)
      clearInterval(budgetReservationSweepInterval)
      clearInterval(pushClaimSweepInterval)
      clearInterval(documentSessionReapInterval)
      clearInterval(cloudBrowserReapInterval)
      clearInterval(deliveryRetryInterval)
      clearInterval(mailboxSweepInterval)
      clearInterval(runnerHeartbeatInterval)
      clearInterval(executionLeaseSweepInterval)
      clearInterval(deadQueueSweepInterval)
      clearInterval(pendingBatchSweepInterval)
      clearInterval(commsRenewInterval)
      clearInterval(commsIncrementalSweepInterval)
      clearInterval(registrySyncSweepInterval)
    },
  }
}
