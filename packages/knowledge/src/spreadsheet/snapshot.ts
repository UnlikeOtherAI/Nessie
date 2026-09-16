import { Readable } from 'node:stream'

import { Prisma } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'
import { canonicalHash, projectWorkbook } from '@nessie/spreadsheet'

import { exportXlsxBytes } from './engine.js'
import {
  assertEngineMatches,
  loadHead,
  lockSpreadsheetPage,
  modelAtHead,
} from './head.js'
import type { SpreadsheetServiceDeps, SpreadsheetWriteActor } from './deps.js'

/**
 * Durable versions — the safety net the whole design leans on.
 *
 * There is no approval gate on agent writes (owner decision 3), so versions
 * are what make any edit reversible. A version captures the whole workbook as
 * an xlsx rendition (durable, engine-independent, downloadable), the engine
 * bytes beside it for a fast restore, and the text projection in `body` so the
 * existing chunk/embed path indexes it like any other page.
 *
 * There is **no retention policy and no approval gate** on versions: they are
 * the thing that makes an unreviewed edit safe, so nothing prunes them.
 */

export const SPREADSHEET_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** Hidden from the drawer by MIME: this blob is an engine detail, not a file. */
export const SPREADSHEET_ICALC_MIME = 'application/vnd.ironcalc'

export type SnapshotReason =
  | 'compaction'
  | 'idle'
  | 'named'
  | 'before-destructive'
  | 'agent-run-start'
  | 'import'
  | 'restore'
  | 'engine-migrate'

export type CreateSnapshotInput = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  attribution: LedgerAttribution
  reason: SnapshotReason
  /** Says *why*, in the words the history list shows. */
  changeComment: string
}

export type SnapshotResult = {
  versionId: string
  seq: number
  /** Null when there was nothing to snapshot (an empty page at seq 0 with no batches). */
  skipped: boolean
}

type RenderedWorkbook = {
  seq: number
  batchesAtSnapshot: number
  bytes: Buffer
  xlsx: Buffer
  body: string
  sourceContentHash: string
}

const renderAtHead = async (
  deps: SpreadsheetServiceDeps,
  input: Pick<CreateSnapshotInput, 'organizationId' | 'pageId'>,
): Promise<RenderedWorkbook> =>
  deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    assertEngineMatches(head)
    const workbook = await modelAtHead(deps, tx as never, head)
    return {
      seq: Number(head.headSeq),
      batchesAtSnapshot: head.batchesSinceSnapshot,
      bytes: Buffer.from(workbook.model.toBytes()),
      // Synchronous in the binding, and ~4 s for a million cells — which is
      // why a large export belongs on the worker. At Nessie's caps this is
      // tens of milliseconds.
      xlsx: exportXlsxBytes(workbook),
      body: projectWorkbook(workbook.model),
      // Never a hash of the bytes: `toBytes()` is not byte-deterministic, so
      // an unchanged workbook would hash differently on every save.
      sourceContentHash: canonicalHash(workbook.model),
    }
  })

export const createSpreadsheetSnapshot = async (
  deps: SpreadsheetServiceDeps,
  input: CreateSnapshotInput,
): Promise<SnapshotResult> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: { id: input.pageId, organizationId: input.organizationId, deletedAt: null },
    select: { id: true, title: true, projectId: true, teamId: true, spaceId: true },
  })
  if (!page) throw new Error('Spreadsheet page not found')

  const rendered = await renderAtHead(deps, input)
  const scope = { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId }
  const store = async (filename: string, mime: string, body: Buffer, asPageBlob: boolean) =>
    deps.fileService.store({
      attribution: input.attribution,
      body: bufferStream(body),
      filename,
      mime,
      organizationId: input.organizationId,
      scope,
      uploaderId: input.actor.type === 'user' ? input.actor.id : null,
      ...(asPageBlob ? { knowledgePageId: input.pageId } : {}),
    })

  const xlsxAttachment = await store(
    `${safeName(page.title)}.xlsx`,
    SPREADSHEET_XLSX_MIME,
    rendered.xlsx,
    false,
  )

  let version
  try {
    version = await deps.addFileVersion({
      organizationId: input.organizationId,
      pageId: input.pageId,
      attachmentId: xlsxAttachment.attachment.id,
      authorId: input.actor.id,
      authorType: input.actor.type,
      changeComment: input.changeComment,
      origin: input.actor.type === 'agent' ? 'agent_authored' : 'user_authored',
      trust: 'explicitly_confirmed',
      body: rendered.body,
      sourceContentHash: rendered.sourceContentHash,
    })
  } catch (error) {
    // Never leave a blob behind that no row points at.
    await deps.fileService
      .delete(xlsxAttachment.attachment.id, input.organizationId, input.attribution, scope)
      .catch(() => undefined)
    throw error
  }
  if (!version) {
    await deps.fileService
      .delete(xlsxAttachment.attachment.id, input.organizationId, input.attribution, scope)
      .catch(() => undefined)
    throw new Error('Spreadsheet version could not be written')
  }

  // The engine bytes ride as a page attachment so restoring a recent version
  // is a `fromBytes` rather than an xlsx re-import. Best effort: losing it
  // costs a slower restore, never the version.
  //
  // Named by **version id**, not by seq. The plan said `@<seq>.icalc`, but a
  // version row carries no seq, so a restore could only guess one from the
  // head — and the head's `snapshotSeq` has already moved by then, because a
  // restore snapshots the *current* state first. That guess found the blob for
  // the state being replaced and restored it over itself: the restore silently
  // did nothing. The version id is the only key both sides actually hold.
  await store(
    `${safeName(page.title)}@${version.id}.icalc`,
    SPREADSHEET_ICALC_MIME,
    rendered.bytes,
    true,
  ).catch(() => undefined)

  await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    // Batches that landed while the xlsx was being written still count as
    // unsaved, so the decrement is by what was pending when the model was
    // read rather than a reset to zero.
    await tx.$executeRaw(Prisma.sql`
      UPDATE spreadsheet_heads
      SET snapshot_version_id = ${version.id}::uuid,
          snapshot_seq = ${BigInt(rendered.seq)},
          batches_since_snapshot = GREATEST(0, batches_since_snapshot - ${rendered.batchesAtSnapshot}),
          updated_at = now()
      WHERE page_id = ${input.pageId}::uuid
    `)
  })

  if (deps.publish) {
    await deps.publish('sheet.snapshot', {
      pageId: input.pageId,
      organizationId: input.organizationId,
      data: { pageId: input.pageId, versionId: version.id, seq: rendered.seq },
    })
  }

  return { versionId: version.id, seq: rendered.seq, skipped: false }
}

const safeName = (title: string): string =>
  (title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'spreadsheet').slice(0, 120)

// `FileService.store` wants a Readable; the bytes are already resident because
// the engine produced them synchronously.
const bufferStream = (buffer: Buffer): Readable => Readable.from([buffer])
