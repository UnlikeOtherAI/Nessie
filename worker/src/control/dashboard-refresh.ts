/**
 * Dashboard data-source refresh.
 *
 * One source has one cache serving every viewer, so viewing a dashboard never
 * causes an outbound request — N viewers cause zero extra fetches. Refresh
 * happens here, and only here.
 *
 * This calls the same `fetchDashboardSource` + `normalizeDashboardDocument` the
 * API's probe calls, differing only in that it persists. There is no second
 * fetch path and no second transform, which is what keeps the egress controls
 * (IP pinning, zero redirects, identity encoding, size caps) impossible to
 * bypass by adding a code path.
 *
 * Scheduling reuses the existing queue and a `nextRunAt`/`claimedAt` claim in
 * the same shape as the trigger poller — no second scheduler, and no
 * AgentTrigger row, so refreshing a chart never spins an agent or spends a
 * token.
 */

import type { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  DashboardFetchError,
  DashboardNormalizeError,
  fetchDashboardSource,
  normalizeDashboardDocument,
  type DashboardEgressPolicy,
} from '@nessie/dashboard'
import type { DashboardOutputColumn } from '@nessie/schemas'
import {
  exponentialBackoffMs,
  type FileService,
  type LedgerAttribution,
} from '@nessie/runtime'

export type DashboardRefreshDeps = {
  prisma: PrismaClient
  fileService: FileService
  egressPolicy: DashboardEgressPolicy
  /** Resolves a `secret_dashboard_*` ref. Server-side only, never returned. */
  resolveCredential: (ref: string) => Promise<string | null>
}

export type DashboardRefreshPayload = { sourceId: string }

/**
 * The worker is the actor; the source authority is who it is done for, so
 * per-user storage totals stay attributed to whoever owns the credential.
 */
const attributionFor = (organizationId: string, userId: string | null): LedgerAttribution => ({
  actorId: 'worker.dashboard-refresh',
  actorType: 'system',
  organizationId,
  systemComponent: 'worker.dashboard-refresh',
  userId,
})

/** Capped exponential backoff: 1m, 2m, 4m … up to six hours. */
const backoffMs = (consecutiveFailures: number): number =>
  exponentialBackoffMs({
    attempt: Math.min(consecutiveFailures, 9),
    baseMs: 60_000,
    capMs: 6 * 60 * 60 * 1000,
  })

const nextRunAfterSuccess = (intervalMinutes: number | null): Date | null =>
  intervalMinutes ? new Date(Date.now() + intervalMinutes * 60_000) : null

/**
 * Retention: keep the newest 50 datasets per source, and never delete one a
 * frozen widget snapshot still points at — a quotation in a message or a page
 * must stay readable after the live data has moved on.
 */
const pruneOldDatasets = async (
  deps: DashboardRefreshDeps,
  sourceId: string,
  organizationId: string,
): Promise<void> => {
  const keep = await deps.prisma.dashboardDataset.findMany({
    where: { sourceId, organizationId },
    orderBy: { fetchedAt: 'desc' },
    take: 50,
    select: { id: true },
  })
  const keepIds = keep.map((row) => row.id)

  const stale = await deps.prisma.dashboardDataset.findMany({
    where: {
      sourceId,
      organizationId,
      id: { notIn: keepIds },
      snapshots: { none: {} },
    },
    select: { id: true, attachmentId: true },
    take: 25,
  })

  for (const dataset of stale) {
    // The FileService is the only place attachment bytes are removed, so the
    // storage ledger stays correct.
    await deps.fileService
      .delete(dataset.attachmentId, organizationId, attributionFor(organizationId, null))
      .catch(() => undefined)
    await deps.prisma.dashboardDataset.delete({ where: { id: dataset.id } }).catch(() => undefined)
  }
}

export const refreshDashboardDataSource = async (
  deps: DashboardRefreshDeps,
  payload: DashboardRefreshPayload,
): Promise<'refreshed' | 'not_modified' | 'failed' | 'skipped'> => {
  const { prisma } = deps
  const source = await prisma.dashboardDataSource.findFirst({
    where: { id: payload.sourceId, archivedAt: null },
  })
  // A source deleted or archived between enqueue and execution: cancel quietly
  // rather than fetching on behalf of something that no longer exists.
  if (!source) return 'skipped'

  const credentialValue = source.credentialRef
    ? await deps.resolveCredential(source.credentialRef)
    : null

  const finishFailure = async (code: string) => {
    const failures = source.consecutiveFailures + 1
    await prisma.dashboardDataSource.update({
      where: { id: source.id },
      data: {
        lastAttemptAt: new Date(),
        lastErrorCode: code,
        consecutiveFailures: failures,
        claimedAt: null,
        nextRunAt: source.refreshMode === 'interval'
          ? new Date(Date.now() + backoffMs(failures))
          : null,
      },
    })
    return 'failed' as const
  }

  let outcome
  try {
    outcome = await fetchDashboardSource(
      {
        origin: source.origin,
        path: source.path,
        queryParams: source.queryParams as Record<string, string> | null,
        etag: source.etag,
        lastModified: source.lastModified,
        ...(credentialValue && source.credentialMode
          ? {
            credential: {
              mode: source.credentialMode as 'bearer' | 'header',
              ...(source.credentialHeader ? { headerName: source.credentialHeader } : {}),
              value: credentialValue,
            },
          }
          : {}),
      },
      deps.egressPolicy,
    )
  } catch (error) {
    // Only a stable code is persisted. An upstream message is
    // attacker-influenced text and never reaches a row a viewer can read.
    return finishFailure(error instanceof DashboardFetchError ? error.code : 'SOURCE_UNREACHABLE')
  }

  if (outcome.status === 'not_modified') {
    // A valid 304 advances freshness without writing another blob.
    await prisma.dashboardDataSource.update({
      where: { id: source.id },
      data: {
        lastAttemptAt: new Date(),
        lastValidatedAt: new Date(),
        lastErrorCode: null,
        consecutiveFailures: 0,
        claimedAt: null,
        nextRunAt: nextRunAfterSuccess(source.intervalMinutes),
      },
    })
    return 'not_modified'
  }

  let dataset
  try {
    dataset = await normalizeDashboardDocument({
      document: outcome.document,
      transform: source.transform,
      columns: source.outputColumns as unknown as DashboardOutputColumn[],
      fetchedAt: new Date(),
    })
  } catch (error) {
    return finishFailure(
      error instanceof DashboardNormalizeError ? error.code : 'SOURCE_SCHEMA_MISMATCH',
    )
  }

  const bytes = Buffer.from(JSON.stringify(dataset), 'utf8')

  // Through the FileService chokepoint, so the dataset is quota-gated and
  // carries a StorageUsageEvent like every other blob.
  let stored
  try {
    stored = await deps.fileService.store({
      attribution: attributionFor(source.organizationId, source.authorityUserId),
      organizationId: source.organizationId,
      uploaderId: source.authorityUserId,
      filename: `dashboard-${source.id}-${randomUUID()}.json`,
      mime: 'application/json',
      body: Readable.from(bytes),
    })
  } catch {
    // Quota exhaustion or a storage failure leaves the PREVIOUS dataset
    // current: a dashboard keeps showing its last good numbers rather than
    // going blank because the disk filled up.
    return finishFailure('SOURCE_DATASET_STORE_FAILED')
  }

  const row = await prisma.dashboardDataset.create({
    data: {
      organizationId: source.organizationId,
      sourceId: source.id,
      attachmentId: stored.attachment.id,
      schemaVersion: dataset.schemaVersion,
      rowCount: dataset.rows.length,
      byteSize: bytes.byteLength,
      fetchedAt: new Date(dataset.fetchedAt),
    },
  })

  await prisma.dashboardDataSource.update({
    where: { id: source.id },
    data: {
      latestDatasetId: row.id,
      lastAttemptAt: new Date(),
      lastValidatedAt: new Date(),
      lastErrorCode: null,
      consecutiveFailures: 0,
      etag: outcome.etag,
      lastModified: outcome.lastModified,
      claimedAt: null,
      nextRunAt: nextRunAfterSuccess(source.intervalMinutes),
    },
  })

  await pruneOldDatasets(deps, source.id, source.organizationId).catch(() => undefined)
  return 'refreshed'
}

/**
 * Claims due sources and enqueues one refresh each.
 *
 * The claim is a conditional update on `claimedAt`, so two workers cannot both
 * take the same source, and a source already running is skipped rather than
 * fetched twice.
 */
export const sweepDueDashboardSources = async (
  prisma: PrismaClient,
  input: { limit: number; now?: Date },
): Promise<{ sourceId: string }[]> => {
  const now = input.now ?? new Date()
  // A claim older than 15 minutes belonged to a worker that died mid-fetch;
  // the 10 s request deadline means nothing legitimate runs that long.
  const staleClaim = new Date(now.getTime() - 15 * 60_000)

  const due = await prisma.dashboardDataSource.findMany({
    where: {
      archivedAt: null,
      refreshMode: 'interval',
      nextRunAt: { lte: now },
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleClaim } }],
    },
    orderBy: { nextRunAt: 'asc' },
    take: input.limit,
    select: { id: true, claimedAt: true },
  })

  const claimed: { sourceId: string }[] = []
  for (const source of due) {
    const result = await prisma.dashboardDataSource.updateMany({
      where: { id: source.id, claimedAt: source.claimedAt },
      data: { claimedAt: now },
    })
    if (result.count === 1) claimed.push({ sourceId: source.id })
  }
  return claimed
}

export const DASHBOARD_REFRESH_TOPIC = 'dashboard.source.refresh'
