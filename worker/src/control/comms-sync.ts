import type { PrismaClient } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import {
  ConnectorNotRegisteredError,
  needsReauthorization,
  resolveConnector,
  SyncCursorExpiredError,
  type CommsProviderId,
  type SyncCheckpoint,
} from '@nessie/comms-connect'
import type {
  CommsSubscriptionsRenewJobPayload,
  CommsSyncIncrementalJobPayload,
  CommsSyncInitialJobPayload,
} from '@nessie/schemas'
import {
  persistNormalizedEvents,
  recordSubscriptions,
  toConnectorContext,
} from './comms-persistence.js'

/**
 * The Individual Communications Connector sync worker. Providers plug into the
 * shared `@nessie/comms-connect` registry later; until then these handlers load
 * a connection, resolve its connector (failing cleanly with a typed error when
 * none is registered), page through the sync phase, persist normalized events
 * idempotently, and advance the resumable `CommsSyncJob` checkpoint after every
 * page. See docs/plans/2026-07-21-individual-communications-connector.md.
 */

export type CommsSyncDeps = {
  prisma: PrismaClient
  encryptionSecret: string
}

/** Safety valve so a misbehaving connector cannot loop forever inside one job. */
const MAX_PAGES_PER_RUN = 100

const DEFAULT_RENEW_WINDOW_MS = 60 * 60 * 1000

/**
 * Overlap subtracted from `lastSuccessfulSyncAt` when seeding the bounded
 * re-sync window after a cursor expiry, so nothing near the boundary is missed.
 */
const CURSOR_RESYNC_OVERLAP_MS = 24 * 60 * 60 * 1000

type SyncPhase = 'history' | 'incremental'

/**
 * Recover from an expired provider cursor: drop the dead cursor, move the job
 * back into a bounded `history` back-fill seeded from the last successful sync
 * (minus a 1-day overlap when known), and mark it `pending` so the next run
 * resumes it instead of retrying the stale token forever.
 */
const resetJobForBoundedResync = async (
  prisma: PrismaClient,
  jobId: string,
  lastSuccessfulSyncAt: Date | null,
  error: SyncCursorExpiredError,
): Promise<void> => {
  const seededOldest = lastSuccessfulSyncAt
    ? new Date(lastSuccessfulSyncAt.getTime() - CURSOR_RESYNC_OVERLAP_MS)
    : null
  await prisma.commsSyncJob.update({
    where: { id: jobId },
    data: {
      phase: 'history',
      cursor: null,
      status: 'pending',
      oldestImportedAt: seededOldest,
      newestImportedAt: null,
      lastError: error.message,
    },
  })
}

const loadConnection = (prisma: PrismaClient, connectionId: string) =>
  prisma.commsConnection.findUnique({
    where: { id: connectionId },
    include: { credential: true },
  })

/**
 * Resume the newest non-terminal sync job for this (connection, resource,
 * phase), or start a fresh one. A completed history back-fill is left alone; an
 * incremental job always continues from the newest job's cursor.
 */
const getOrCreateSyncJob = async (
  prisma: PrismaClient,
  params: { connectionId: string; resourceId?: string; phase: SyncPhase },
): Promise<{ job: Prisma.CommsSyncJobGetPayload<object>; alreadyComplete: boolean }> => {
  const latest = await prisma.commsSyncJob.findFirst({
    where: {
      connectionId: params.connectionId,
      resourceId: params.resourceId ?? null,
      phase: params.phase,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (params.phase === 'history' && latest?.status === 'completed') {
    return { job: latest, alreadyComplete: true }
  }

  if (latest && latest.status !== 'completed') {
    const job = await prisma.commsSyncJob.update({
      where: { id: latest.id },
      data: { status: 'running' },
    })
    return { job, alreadyComplete: false }
  }

  const job = await prisma.commsSyncJob.create({
    data: {
      connectionId: params.connectionId,
      resourceId: params.resourceId ?? null,
      phase: params.phase,
      status: 'running',
      cursor: latest?.cursor ?? null,
      oldestImportedAt: latest?.oldestImportedAt ?? null,
      newestImportedAt: latest?.newestImportedAt ?? null,
    },
  })
  return { job, alreadyComplete: false }
}

const checkpointFromJob = (
  job: Prisma.CommsSyncJobGetPayload<object>,
): SyncCheckpoint => ({
  cursor: job.cursor ?? undefined,
  oldestImportedAt: job.oldestImportedAt?.toISOString(),
  newestImportedAt: job.newestImportedAt?.toISOString(),
})

const runSyncPhase = async (
  deps: CommsSyncDeps,
  payload: { connectionId: string; resourceId?: string },
  phase: SyncPhase,
): Promise<void> => {
  const { prisma, encryptionSecret } = deps
  const connection = await loadConnection(prisma, payload.connectionId)
  if (!connection) {
    console.warn(`[comms-sync] connection ${payload.connectionId} not found`)
    return
  }
  if (connection.status === 'disconnected') {
    console.warn(`[comms-sync] connection ${connection.id} is disconnected — skipping`)
    return
  }

  const { job, alreadyComplete } = await getOrCreateSyncJob(prisma, {
    connectionId: payload.connectionId,
    resourceId: payload.resourceId,
    phase,
  })
  if (alreadyComplete) {
    return
  }

  let connector
  try {
    connector = resolveConnector(connection.provider)
  } catch (error) {
    if (error instanceof ConnectorNotRegisteredError) {
      await prisma.commsSyncJob.update({
        where: { id: job.id },
        data: { status: 'failed', lastError: error.message },
      })
      console.warn(`[comms-sync] ${error.message} — job ${job.id} parked`)
      return
    }
    throw error
  }

  const context = toConnectorContext(connection, encryptionSecret)

  try {
    let checkpoint = checkpointFromJob(job)
    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const result =
        phase === 'history'
          ? await connector.runInitialSync(context, checkpoint)
          : await connector.runIncrementalSync(context, checkpoint)

      await persistNormalizedEvents(
        prisma,
        { connectionId: connection.id, organizationId: connection.organizationId },
        result.events,
      )
      if (result.subscriptions?.length) {
        await recordSubscriptions(prisma, connection, result.subscriptions)
      }

      checkpoint = result.checkpoint
      // Advance the resumable checkpoint after every page so a failure resumes
      // instead of restarting.
      await prisma.commsSyncJob.update({
        where: { id: job.id },
        data: {
          cursor: checkpoint.cursor ?? null,
          oldestImportedAt: checkpoint.oldestImportedAt
            ? new Date(checkpoint.oldestImportedAt)
            : null,
          newestImportedAt: checkpoint.newestImportedAt
            ? new Date(checkpoint.newestImportedAt)
            : null,
          status: 'running',
        },
      })

      if (!result.hasMore) {
        break
      }
    }

    await prisma.commsSyncJob.update({
      where: { id: job.id },
      data: { status: 'completed', lastError: null },
    })
    await prisma.commsConnection.update({
      where: { id: connection.id },
      data: {
        lastSuccessfulSyncAt: new Date(),
        ...(phase === 'history' && !connection.initialSyncCompletedAt
          ? { initialSyncCompletedAt: new Date() }
          : {}),
      },
    })
  } catch (error) {
    // An expired provider cursor will never succeed on retry against the same
    // stale token: reset the job to a bounded re-sync and stop (no rethrow, so
    // the queue does not retry the dead cursor).
    if (error instanceof SyncCursorExpiredError) {
      await resetJobForBoundedResync(
        prisma,
        job.id,
        connection.lastSuccessfulSyncAt,
        error,
      )
      console.warn(
        `[comms-sync] cursor expired for connection ${connection.id} — `
          + `job ${job.id} reset for bounded re-sync`,
      )
      return
    }
    // A credential the provider rejected cannot be salvaged by retrying with the
    // same dead token: park the connection for re-authorization, fail the job,
    // and do not rethrow.
    if (needsReauthorization(error)) {
      await prisma.commsConnection.update({
        where: { id: connection.id },
        data: { status: 'needs_reauthorization' },
      })
      await prisma.commsSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lastError: 'credential rejected by provider; reauthorization required',
        },
      })
      console.warn(
        `[comms-sync] connection ${connection.id} needs reauthorization — `
          + `job ${job.id} failed`,
      )
      return
    }
    // Persist the failure but rethrow so the queue retries; the stored cursor
    // makes the retry resume rather than restart.
    await prisma.commsSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        retryCount: { increment: 1 },
        lastError: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}

export const executeCommsInitialSyncJob = (
  deps: CommsSyncDeps,
  payload: CommsSyncInitialJobPayload,
): Promise<void> => runSyncPhase(deps, payload, 'history')

export const executeCommsIncrementalSyncJob = (
  deps: CommsSyncDeps,
  payload: CommsSyncIncrementalJobPayload,
): Promise<void> => runSyncPhase(deps, payload, 'incremental')

/**
 * Renewal sweep: find every active subscription expiring within the window and
 * ask each connection's connector to renew it. Connections whose provider has
 * no registered connector are skipped cleanly; a per-connection failure is
 * logged and does not abort the sweep.
 */
export const renewCommsSubscriptions = async (
  deps: CommsSyncDeps,
  payload: CommsSubscriptionsRenewJobPayload,
): Promise<void> => {
  const { prisma, encryptionSecret } = deps
  const withinMs = payload.withinMs ?? DEFAULT_RENEW_WINDOW_MS
  const threshold = new Date(Date.now() + withinMs)

  const due = await prisma.commsSubscription.findMany({
    where: { status: 'active', expiresAt: { lte: threshold } },
    include: { connection: { include: { credential: true } } },
  })

  const connections = new Map<string, (typeof due)[number]['connection']>()
  for (const subscription of due) {
    connections.set(subscription.connection.id, subscription.connection)
  }

  for (const connection of connections.values()) {
    if (connection.status === 'disconnected' || !connection.credential) {
      continue
    }
    try {
      const connector = resolveConnector(connection.provider as CommsProviderId)
      const context = toConnectorContext(connection, encryptionSecret)
      const descriptors = await connector.renewSubscriptions(context)
      await recordSubscriptions(prisma, connection, descriptors)
    } catch (error) {
      if (error instanceof ConnectorNotRegisteredError) {
        continue
      }
      console.error(
        `[comms-sync] subscription renewal failed for connection ${connection.id}`,
        error,
      )
    }
  }
}
