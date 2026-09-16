import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'

import { engineVersion } from './engine.js'
import { invalidRequest } from './errors.js'
import { loadHead, lockSpreadsheetPage } from './head.js'
import { workbookForVersion } from './restore.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * Bumping `SPREADSHEET_ENGINE_VERSION` is a data event, and a simple one:
 * production is greenfield, so there is **no** dual-engine alias, no format
 * shim and no compatibility layer. One job per page.
 *
 * The order matters and is what makes a blue-green swap safe:
 *
 * - The *previous* release snapshots every page with unsaved batches as the
 *   last step of its own deploy, because producing an xlsx from the old bytes
 *   needs the old engine.
 * - The new release rebuilds each page from that xlsx. Until a page is
 *   migrated its write door answers `409 SPREADSHEET_ENGINE_MISMATCH` and the
 *   pane says "being upgraded, read only".
 * - Anything the xlsx cannot carry is lost at that point. That is by design:
 *   the xlsx is the format of record, because `bitcode` bytes are
 *   version-coupled and undecodable outside the exact crate version.
 *
 * The filter model is ours and lives on the head, so it survives untouched.
 */

export type EngineMigrateInput = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
}

export type EngineMigrateResult = {
  migrated: boolean
  fromEngineVersion: string
  toEngineVersion: string
  seq: number
}

export const migrateSpreadsheetEngine = async (
  deps: SpreadsheetServiceDeps,
  input: EngineMigrateInput,
): Promise<EngineMigrateResult> => {
  const head = await loadHead(deps.prisma as never, input.organizationId, input.pageId)
  const target = engineVersion()
  if (head.engineVersion === target) {
    return {
      migrated: false,
      fromEngineVersion: head.engineVersion,
      toEngineVersion: target,
      seq: Number(head.headSeq),
    }
  }

  if (!head.snapshotVersionId) {
    // Without a durable version there is nothing this engine can read: the old
    // release was supposed to take one before the swap.
    throw invalidRequest(
      'This spreadsheet has no durable version to rebuild from; run the pre-deploy snapshot job first',
      { pageId: input.pageId, engineVersion: head.engineVersion },
    )
  }

  // Deliberately from the xlsx and never from the `.icalc` bytes: those are the
  // *old* engine's format, which is exactly what cannot be read here.
  const workbook = await workbookForVersion(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    versionId: head.snapshotVersionId,
    seq: null,
  })
  const bytes = Buffer.from(workbook.model.toBytes())
  const sheetNames = workbook.model.sheets().map((sheet) => sheet.name)

  const seq = await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const current = await loadHead(tx as never, input.organizationId, input.pageId)
    if (current.engineVersion === target) return Number(current.headSeq)
    const next = Number(current.headSeq) + 1
    await tx.spreadsheetOpBatch.create({
      data: {
        pageId: input.pageId,
        organizationId: input.organizationId,
        seq: BigInt(next),
        baseSeq: current.headSeq,
        clientOpId: randomUUID(),
        actorType: input.actor.type,
        actorId: input.actor.id,
        engineVersion: target,
        diffs: Buffer.alloc(0),
        structuralKind: 'restore',
        sheetIndexes: [],
        cellCount: 0,
        summary: { structuralKind: 'restore', sheetIndexes: [], cellCount: 0, touched: [] },
      },
    })
    await tx.spreadsheetHead.update({
      where: { pageId: input.pageId },
      data: {
        headSeq: BigInt(next),
        engineVersion: target,
        hotSnapshot: bytes,
        hotSnapshotSeq: BigInt(next),
        sheetNames,
        batchesSinceSnapshot: { increment: 1 },
        lastOpAt: new Date(),
      },
    })
    // Batches encoded by the old engine can never be applied again; keeping
    // them would only let a catch-up hand a client bytes it cannot decode.
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM spreadsheet_op_batches
      WHERE page_id = ${input.pageId}::uuid AND seq < ${BigInt(next)}
    `)
    return next
  })

  deps.cache.evict(input.pageId)
  await deps.publish?.('sheet.closed', {
    pageId: input.pageId,
    organizationId: input.organizationId,
    data: { pageId: input.pageId, reason: 'engine-migrating' },
  })

  return {
    migrated: true,
    fromEngineVersion: head.engineVersion,
    toEngineVersion: target,
    seq,
  }
}
