import { Prisma, type PrismaClient } from '@prisma/client'
import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import { engineMismatch, spreadsheetNotFound } from './errors.js'
import {
  applyDiffs,
  engineVersion,
  isEmptyDiffPayload,
  loadWorkbook,
  type SpreadsheetWorkbook,
} from './engine.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * The head row, the per-page lock, and the one way a model is brought up to
 * head. Everything that reads or writes a spreadsheet goes through here, so
 * "the cache is fast-forwarded from the journal before every use" is a
 * property of one function rather than a rule every caller has to remember.
 */

export type SpreadsheetHeadRow = {
  pageId: string
  organizationId: string
  headSeq: bigint
  engineVersion: string
  hotSnapshot: Uint8Array
  hotSnapshotSeq: bigint
  snapshotVersionId: string | null
  snapshotSeq: bigint
  batchesSinceSnapshot: number
  sheetNames: string[]
  filters: Prisma.JsonValue
  lastOpAt: Date | null
}

type Queryable = Pick<PrismaClient, '$executeRaw' | '$queryRaw'> & {
  spreadsheetHead: PrismaClient['spreadsheetHead']
  spreadsheetOpBatch: PrismaClient['spreadsheetOpBatch']
}

/**
 * Serialises every write to one page, and every read that needs the model at
 * an exact seq. Transaction-scoped, so it is released by COMMIT or ROLLBACK
 * and no code path can leak it.
 */
export const lockSpreadsheetPage = async (tx: Queryable, pageId: string): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`spreadsheet:${pageId}`}, 0))
  `)
}

export const loadHead = async (
  tx: Queryable,
  organizationId: string,
  pageId: string,
): Promise<SpreadsheetHeadRow> => {
  const head = await tx.spreadsheetHead.findFirst({ where: { pageId, organizationId } })
  if (!head) throw spreadsheetNotFound(pageId)
  return head as SpreadsheetHeadRow
}

/** Writes are refused against a head this build's engine cannot decode. */
export const assertEngineMatches = (head: SpreadsheetHeadRow): void => {
  if (head.engineVersion !== engineVersion()) {
    throw engineMismatch(head.pageId, head.engineVersion, engineVersion())
  }
}

/**
 * The model at `head.headSeq`, from the process cache when it is usable and
 * from the hot snapshot plus the journal when it is not.
 *
 * A cache hit is never trusted on its own: its `seq` is compared with the head
 * read in this transaction, and any batches in between are applied before the
 * model is handed back. A hit at a *higher* seq than the head is impossible
 * under the lock and is treated as corruption — the entry is dropped and the
 * model rebuilt.
 */
export const modelAtHead = async (
  deps: SpreadsheetServiceDeps,
  tx: Queryable,
  head: SpreadsheetHeadRow,
): Promise<SpreadsheetWorkbook> => {
  const headSeq = Number(head.headSeq)
  const cached = deps.cache.get(head.pageId)
  let workbook: SpreadsheetWorkbook
  let from: number

  if (cached && cached.engineVersion === head.engineVersion && cached.seq <= headSeq) {
    workbook = cached.workbook
    from = cached.seq
  } else {
    if (cached) deps.cache.evict(head.pageId)
    workbook = loadWorkbook(head.hotSnapshot)
    from = Number(head.hotSnapshotSeq)
  }

  if (from < headSeq) {
    let batches = await tx.spreadsheetOpBatch.findMany({
      where: { pageId: head.pageId, seq: { gt: BigInt(from), lte: head.headSeq } },
      orderBy: { seq: 'asc' },
      select: { seq: true, diffs: true, structuralKind: true },
    })

    // A restore (and an import, which uses the same shape) is an instruction to
    // start again, not a payload: it carries no diffs, and no sequence of diffs
    // could turn this model into the restored workbook anyway. Replaying it
    // threw `Error parsing diff list` and took the whole request with it — on
    // *another* replica than the one that restored, because that replica's
    // cache still held the pre-restore model and fast-forwarded across the
    // marker. The restore writes the hot snapshot at its own seq, so rebuilding
    // from there is both correct and already paid for.
    const restart = batches.some((batch) => batch.structuralKind === 'restore')
    if (restart) {
      deps.cache.evict(head.pageId)
      workbook = loadWorkbook(head.hotSnapshot)
      from = Number(head.hotSnapshotSeq)
      batches = batches.filter((batch) => Number(batch.seq) > from)
    }

    // One pause/resume/evaluate for the whole catch-up, not one per batch.
    workbook.model.pauseEvaluation()
    try {
      for (const batch of batches) {
        // An empty payload is the encoded empty list, never a diff to apply.
        if (isEmptyDiffPayload(batch.diffs)) continue
        workbook.model.applyExternalDiffs(batch.diffs)
      }
    } finally {
      workbook.model.resumeEvaluation()
    }
    workbook.model.evaluate()
  }

  deps.cache.set(head.pageId, {
    workbook,
    seq: headSeq,
    engineVersion: head.engineVersion,
    bytes: cached?.bytes ?? head.hotSnapshot.byteLength,
  })
  return workbook
}

/** Re-export so callers need only this module for the apply dance. */
export { applyDiffs }

export const sheetNamesOf = (workbook: SpreadsheetWorkbook): string[] =>
  workbook.model.sheets().map((sheet) => sheet.name)

/**
 * Is a fresh hot snapshot due? The cadence bounds what a cold replica pays: at
 * most `hotSnapshotEveryBatches` journal applies on top of one `fromBytes`.
 */
export const hotSnapshotDue = (head: SpreadsheetHeadRow, seq: number): boolean =>
  seq - Number(head.hotSnapshotSeq) >= SPREADSHEET_LIMITS.hotSnapshotEveryBatches
