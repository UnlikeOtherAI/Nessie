import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'

import {
  engineVersion,
  importXlsxBytes,
  loadWorkbook,
  type SpreadsheetWorkbook,
} from './engine.js'
import { invalidRequest } from './errors.js'
import { lockSpreadsheetPage, loadHead } from './head.js'
import { createSpreadsheetSnapshot, SPREADSHEET_ICALC_MIME } from './snapshot.js'
import { toSpreadsheetActor, type SpreadsheetServiceDeps, type SpreadsheetWriteActor } from './deps.js'

/**
 * Restore — a first-class operation, not an edge case.
 *
 * Versions are the only thing making an unreviewed agent edit safe, so
 * restoring one has to be as ordinary as saving one. A restore takes its own
 * version of the current state first (`before: restore to v12`), so the
 * restore is itself reversible, and appends a `restore` batch that tells every
 * open pane to re-bootstrap rather than try to apply diffs.
 */

const readAttachment = async (
  deps: SpreadsheetServiceDeps,
  attachmentId: string,
  organizationId: string,
): Promise<Buffer | null> => {
  const opened = await deps.fileService.openStream(attachmentId, organizationId)
  if (!opened) return null
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

/**
 * The workbook a version describes: the `.icalc` bytes when this build's
 * engine can still read them, and the xlsx rendition otherwise.
 *
 * The xlsx is the format of record precisely because `bitcode` bytes are
 * version-coupled and undecodable outside the exact crate version — a person's
 * spreadsheet has to outlive an engine bump.
 */
export const workbookForVersion = async (
  deps: SpreadsheetServiceDeps,
  input: {
    organizationId: string
    pageId: string
    versionId: string
    /**
     * Refuse the `.icalc` fast path and go through the xlsx. Set by
     * engine-migrate, whose whole problem is that the engine bytes are the
     * *old* engine's format.
     */
    xlsxOnly?: boolean
  },
): Promise<SpreadsheetWorkbook> => {
  const version = await deps.prisma.knowledgePageVersion.findFirst({
    where: { id: input.versionId, pageId: input.pageId },
    select: { id: true, attachmentId: true },
  })
  if (!version?.attachmentId) {
    throw invalidRequest('That version has no spreadsheet rendition', { versionId: input.versionId })
  }

  if (!input.xlsxOnly) {
    // Keyed by version id: it is the only name both the writer and this
    // reader hold. Keying it by seq restored the wrong state (see snapshot.ts).
    const icalc = await deps.prisma.attachment.findFirst({
      where: {
        knowledgePageId: input.pageId,
        organizationId: input.organizationId,
        mime: SPREADSHEET_ICALC_MIME,
        filename: { endsWith: `@${input.versionId}.icalc` },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    })
    if (icalc) {
      const bytes = await readAttachment(deps, icalc.id, input.organizationId)
      if (bytes) {
        try {
          return loadWorkbook(bytes)
        } catch {
          // Version-coupled bytes this build cannot decode: fall through to
          // the xlsx, which is exactly why it is stored.
        }
      }
    }
  }

  const xlsx = await readAttachment(deps, version.attachmentId, input.organizationId)
  if (!xlsx) throw invalidRequest('That version could not be read', { versionId: input.versionId })
  return importXlsxBytes(xlsx)
}

export type RestoreSpreadsheetInput = {
  organizationId: string
  pageId: string
  versionId: string
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
}

export type RestoreSpreadsheetResult = {
  seq: number
  /** The version taken of the pre-restore state, so the restore can be undone. */
  previousVersionId: string | null
}

export const restoreSpreadsheetVersion = async (
  deps: SpreadsheetServiceDeps,
  input: RestoreSpreadsheetInput,
): Promise<RestoreSpreadsheetResult> => {
  const version = await deps.prisma.knowledgePageVersion.findFirst({
    where: { id: input.versionId, pageId: input.pageId },
    select: { id: true, versionNumber: true },
  })
  if (!version) throw invalidRequest('Version not found', { versionId: input.versionId })

  // Snapshot first, always: a restore that cannot itself be undone is a
  // destructive operation with no safety net.
  let previousVersionId: string | null = null
  try {
    const before = await createSpreadsheetSnapshot(deps, {
      organizationId: input.organizationId,
      pageId: input.pageId,
      actor: input.actor,
      attribution: input.attribution,
      reason: 'restore',
      changeComment: `before: restore to v${version.versionNumber}`,
    })
    previousVersionId = before.versionId
  } catch (error) {
    console.error('[spreadsheet] pre-restore version failed', {
      pageId: input.pageId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const workbook = await workbookForVersion(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    versionId: input.versionId,
  })
  const bytes = Buffer.from(workbook.model.toBytes())
  const sheetNames = workbook.model.sheets().map((sheet) => sheet.name)

  const seq = await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    const next = Number(head.headSeq) + 1
    // An empty-diff batch: a client cannot transform its model into the
    // restored one, so `structuralKind: 'restore'` is the instruction to
    // re-bootstrap rather than a payload to apply.
    await tx.spreadsheetOpBatch.create({
      data: {
        pageId: input.pageId,
        organizationId: input.organizationId,
        seq: BigInt(next),
        baseSeq: head.headSeq,
        clientOpId: randomUUID(),
        actorType: input.actor.type,
        actorId: input.actor.id,
        agentId: input.actor.agentId ?? null,
        runId: input.actor.runId ?? null,
        agentCredentialId: input.actor.agentCredentialId ?? null,
        engineVersion: engineVersion(),
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
        hotSnapshot: bytes,
        hotSnapshotSeq: BigInt(next),
        engineVersion: engineVersion(),
        sheetNames,
        // The restored workbook's hidden rows are whatever the version had;
        // the filter models described a grid that no longer exists.
        filters: {} as Prisma.InputJsonValue,
        batchesSinceSnapshot: { increment: 1 },
        lastOpAt: new Date(),
      },
    })
    return next
  })

  deps.cache.evict(input.pageId)
  deps.cache.set(input.pageId, {
    workbook,
    seq,
    engineVersion: engineVersion(),
    bytes: bytes.byteLength,
  })

  await deps.publish?.('sheet.ops', {
    pageId: input.pageId,
    organizationId: input.organizationId,
    data: {
      batchId: randomUUID(),
      pageId: input.pageId,
      seq,
      baseSeq: seq - 1,
      clientOpId: randomUUID(),
      actor: toSpreadsheetActor(input.actor),
      engineVersion: engineVersion(),
      diffs: null,
      structuralKind: 'restore',
      sheetIndexes: [],
      cellCount: 0,
      createdAt: new Date().toISOString(),
    },
  })

  // A restored workbook is a new state of record, so it gets its own version.
  await createSpreadsheetSnapshot(deps, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    actor: input.actor,
    attribution: input.attribution,
    reason: 'restore',
    changeComment: `restore: v${version.versionNumber}`,
  })

  return { seq, previousVersionId }
}
