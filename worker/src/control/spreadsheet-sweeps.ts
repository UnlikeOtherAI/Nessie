import { Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import { SPREADSHEET_LIMITS } from '@nessie/schemas'
import {
  createSpreadsheetService,
  engineVersion,
  migrateSpreadsheetEngine,
} from '@nessie/knowledge'
import { z } from 'zod'

import { SPREADSHEET_COMPACT_TOPIC } from './spreadsheet-compact.js'
import type { SpreadsheetCompactDeps } from './spreadsheet-compact.js'

/**
 * The unattended half of the spreadsheet lifecycle: the sweeps that run on a
 * timer rather than behind a write.
 *
 * Three of them, and deliberately three rather than one pass with three
 * branches — a failure in any of them must not stop the others.
 *
 * 1. **Idle compaction.** The write door enqueues a compaction every
 *    `compactEveryBatches` batches. A page edited nineteen times and then left
 *    alone never reaches that count, so its last edits would live only in the
 *    journal: no durable version to restore, and a search index that still
 *    describes the workbook as it was. This sweep closes that window at
 *    `compactAfterIdleMs`.
 * 2. **Journal pruning.** Batches whose state is already folded into both the
 *    hot snapshot and a durable version are replay ballast. Past
 *    `opsRetentionDays` they go.
 * 3. **Engine migration.** After `SPREADSHEET_ENGINE_VERSION` is bumped, every
 *    page still on the old pin refuses writes until it is rebuilt from its
 *    xlsx. This sweep is what rebuilds them; without it
 *    `migrateSpreadsheetEngine` has no caller outside its own test.
 *
 * **There is no version-retention policy here, and Phase 5 must not add one**
 * (owner decision, `docs/plans/2026-09-15-spreadsheets-ironcalc/overview.md`
 * §"Remaining unknowns"). Versions are the only thing that makes an
 * unreviewed agent edit reversible; what these sweeps bound is replay cost and
 * index staleness, never history. Pruning applies to journal batches and to
 * nothing else.
 *
 * Every sweep is bounded (a row limit per tick), runs under the same
 * `withSweepLock` advisory lock at its call site so only one replica takes a
 * tick, and isolates errors per page: one unreadable head costs its own page
 * and not the other forty-nine.
 */

/** Shared by all three sweeps; one tick, one lock. */
export const SPREADSHEET_SWEEP_LOCK = 'spreadsheet-sweeps'
export const SPREADSHEET_SWEEP_INTERVAL_MS = 60_000

/** Pages considered per tick. Bounded so a tick stays short on a big estate. */
const DEFAULT_PAGE_LIMIT = 50
/** Journal rows deleted per page per tick. */
const DEFAULT_PRUNE_ROW_LIMIT = 5_000

export const SPREADSHEET_ENGINE_MIGRATE_TOPIC = 'spreadsheet.engine-migrate'

export const SpreadsheetEngineMigrateJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  pageId: z.string().uuid(),
  /** The pin this job was enqueued for; a later bump supersedes it. */
  toEngineVersion: z.string().min(1),
})
export type SpreadsheetEngineMigrateJobPayload = z.infer<
  typeof SpreadsheetEngineMigrateJobPayloadSchema
>

/**
 * Keyed by the target version, not by a cadence step: a page migrated to
 * 0.8.3 and later to 0.9.0 is two different jobs, and two replicas noticing
 * the same bump are one.
 */
export const spreadsheetEngineMigrateJobKey = (pageId: string, toEngineVersion: string): string =>
  `sheet-engine-migrate:${pageId}:${toEngineVersion}`

/** The idle sweep keys on the head it saw, never on the compaction cadence. */
export const spreadsheetIdleCompactJobKey = (pageId: string, headSeq: bigint | number): string =>
  `sheet-compact-idle:${pageId}:${headSeq.toString()}`

type SweepPrisma = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>

export type SpreadsheetSweepResult = {
  /** Pages this tick acted on. */
  acted: number
  /** Pages that threw and were skipped. */
  failed: number
}

// ────────────────────────────────────────────────────────── idle compaction

type IdleHeadRow = { page_id: string; organization_id: string; head_seq: bigint }

/**
 * Enqueues rather than compacting inline. Compaction needs a `FileService`, a
 * knowledge provider and the process model cache — the deps the
 * `spreadsheet.compact` subscription already holds — and its handler is
 * idempotent on "no batches since the last version", so a redelivery costs one
 * query. The sweep's job is only to notice.
 *
 * The idempotency key carries `head_seq`, not the compaction cadence step.
 * `spreadsheetCompactJobKey` floors the seq by `compactEveryBatches`, so a page
 * idle at seq 5 and again at seq 12 would collapse into one cadence-step-0 key
 * and the second set of edits would wait for batch 200.
 */
export const sweepIdleSpreadsheets = async (
  prisma: SweepPrisma,
  options: { limit?: number; now?: Date } = {},
): Promise<SpreadsheetSweepResult> => {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  const idleBefore = new Date(
    (options.now?.getTime() ?? Date.now()) - SPREADSHEET_LIMITS.compactAfterIdleMs,
  )

  const rows = await prisma.$queryRaw<IdleHeadRow[]>(Prisma.sql`
    SELECT h.page_id, h.organization_id, h.head_seq
    FROM spreadsheet_heads h
    JOIN knowledge_pages p ON p.id = h.page_id
    WHERE h.batches_since_snapshot > 0
      AND h.last_op_at IS NOT NULL
      AND h.last_op_at < ${idleBefore}
      AND h.engine_version = ${engineVersion()}
      AND p.deleted_at IS NULL
    ORDER BY h.last_op_at ASC
    LIMIT ${limit}
  `)

  let acted = 0
  let failed = 0
  for (const row of rows) {
    try {
      const enqueued = await enqueueQueueJob(prisma as never, {
        idempotencyKey: spreadsheetIdleCompactJobKey(row.page_id, row.head_seq),
        payload: {
          organizationId: row.organization_id,
          pageId: row.page_id,
          seq: Number(row.head_seq),
        },
        topic: SPREADSHEET_COMPACT_TOPIC,
      })
      if (enqueued) acted += 1
    } catch (error) {
      failed += 1
      console.error('[worker.spreadsheet-idle-compact] page failed', row.page_id, error)
    }
  }
  return { acted, failed }
}

// ──────────────────────────────────────────────────────────── journal prune

type PrunablePageRow = { page_id: string; keep_from: bigint }

/**
 * Deletes journal batches no reader can still need.
 *
 * The floor is `LEAST(snapshot_seq, hot_snapshot_seq)`, and both halves matter.
 * `modelAtHead` loads `hot_snapshot` and replays everything above
 * `hot_snapshot_seq`, so a batch at or below that seq is already in the bytes;
 * `snapshot_seq` keeps the journal back to the newest durable version, so the
 * rows saying who changed what since it outlive it. A client whose `sinceSeq`
 * falls below the remaining journal is answered `SPREADSHEET_CATCH_UP_EXPIRED`
 * and re-bootstraps — `listSpreadsheetBatches` already answers that way, which
 * is what makes this deletion safe rather than merely bounded.
 */
export const pruneSpreadsheetOpBatches = async (
  prisma: SweepPrisma,
  options: { limit?: number; rowLimit?: number; now?: Date } = {},
): Promise<SpreadsheetSweepResult & { deleted: number }> => {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  const rowLimit = options.rowLimit ?? DEFAULT_PRUNE_ROW_LIMIT
  const cutoff = new Date(
    (options.now?.getTime() ?? Date.now())
    - SPREADSHEET_LIMITS.opsRetentionDays * 24 * 60 * 60 * 1000,
  )

  const pages = await prisma.$queryRaw<PrunablePageRow[]>(Prisma.sql`
    SELECT h.page_id, LEAST(h.snapshot_seq, h.hot_snapshot_seq) AS keep_from
    FROM spreadsheet_heads h
    WHERE EXISTS (
      SELECT 1 FROM spreadsheet_op_batches b
      WHERE b.page_id = h.page_id
        AND b.seq <= LEAST(h.snapshot_seq, h.hot_snapshot_seq)
        AND b.created_at < ${cutoff}
    )
    LIMIT ${limit}
  `)

  let acted = 0
  let failed = 0
  let deleted = 0
  for (const page of pages) {
    try {
      const removed = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM spreadsheet_op_batches
        WHERE id IN (
          SELECT id FROM spreadsheet_op_batches
          WHERE page_id = ${page.page_id}::uuid
            AND seq <= ${page.keep_from}
            AND created_at < ${cutoff}
          ORDER BY seq ASC
          LIMIT ${rowLimit}
        )
      `)
      if (removed > 0) {
        acted += 1
        deleted += removed
      }
    } catch (error) {
      failed += 1
      console.error('[worker.spreadsheet-prune] page failed', page.page_id, error)
    }
  }
  return { acted, failed, deleted }
}

// ───────────────────────────────────────────────────────── engine migration

type StaleEngineRow = { page_id: string; organization_id: string }

/**
 * Enqueues a rebuild for every page still encoded by a previous engine pin.
 *
 * It enqueues for the same reason idle compaction does — the rebuild reads an
 * xlsx attachment through `FileService` — and because a rebuild that fails
 * should retry on the queue's terms rather than silently on a timer.
 *
 * `snapshot_version_id IS NOT NULL` is not an optimisation: without a durable
 * version there is nothing this engine can read, `migrateSpreadsheetEngine`
 * refuses, and enqueuing would only burn three attempts per tick telling us so.
 * Such a page is the pre-swap snapshot step's failure, not this sweep's.
 */
export const sweepStaleSpreadsheetEngines = async (
  prisma: SweepPrisma,
  options: { limit?: number } = {},
): Promise<SpreadsheetSweepResult> => {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  const target = engineVersion()

  const rows = await prisma.$queryRaw<StaleEngineRow[]>(Prisma.sql`
    SELECT h.page_id, h.organization_id
    FROM spreadsheet_heads h
    JOIN knowledge_pages p ON p.id = h.page_id
    WHERE h.engine_version <> ${target}
      AND h.snapshot_version_id IS NOT NULL
      AND p.deleted_at IS NULL
    ORDER BY h.updated_at ASC
    LIMIT ${limit}
  `)

  let acted = 0
  let failed = 0
  for (const row of rows) {
    try {
      const enqueued = await enqueueQueueJob(prisma as never, {
        idempotencyKey: spreadsheetEngineMigrateJobKey(row.page_id, target),
        payload: {
          organizationId: row.organization_id,
          pageId: row.page_id,
          toEngineVersion: target,
        },
        topic: SPREADSHEET_ENGINE_MIGRATE_TOPIC,
      })
      if (enqueued) acted += 1
    } catch (error) {
      failed += 1
      console.error('[worker.spreadsheet-engine-migrate] enqueue failed', row.page_id, error)
    }
  }
  return { acted, failed }
}

/**
 * The queued half of the migration: rebuild one page from its xlsx version.
 *
 * A head already on this build's engine is a no-op, so a redelivery is free. A
 * payload naming a version this build is not on is dropped rather than
 * applied: the pin moved again while the job waited, and the sweep has already
 * enqueued the right one.
 */
export const executeSpreadsheetEngineMigrateJob = async (
  deps: SpreadsheetCompactDeps,
  payload: SpreadsheetEngineMigrateJobPayload,
): Promise<{ migrated: boolean }> => {
  if (payload.toEngineVersion !== engineVersion()) return { migrated: false }

  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: payload.pageId, organizationId: payload.organizationId, deletedAt: null },
    select: { createdBy: true },
  })
  if (!page) return { migrated: false }

  const service = createSpreadsheetService({
    prisma: deps.prisma,
    fileService: deps.fileService,
    cache: deps.cache,
    createPage: deps.createPage,
    addFileVersion: deps.addFileVersion,
    ...(deps.realtime
      ? {
          publish: async (event, input) => {
            await deps.realtime?.publishDocumentEphemeral(
              input.pageId,
              input.organizationId,
              event,
              input.data,
            )
          },
        }
      : {}),
  })

  const result = await migrateSpreadsheetEngine(service, {
    organizationId: payload.organizationId,
    pageId: payload.pageId,
    // The same attribution shape as a compaction: the page's creator, so the
    // row names somebody who can be looked up, and a system attribution that
    // says plainly no person asked for this.
    actor: { type: 'user', id: page.createdBy, displayName: 'Nessie' },
    attribution: {
      organizationId: payload.organizationId,
      actorType: 'system',
      actorId: 'spreadsheet-engine-migrate',
    } as Parameters<typeof migrateSpreadsheetEngine>[1]['attribution'],
  })
  return { migrated: result.migrated }
}
