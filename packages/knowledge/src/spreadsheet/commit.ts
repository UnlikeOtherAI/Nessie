import { Prisma } from '@prisma/client'
import {
  SPREADSHEET_LIMITS,
  type SpreadsheetAppliedBatch,
  type SpreadsheetBatchSummary,
} from '@nessie/schemas'
import type { SpreadsheetEngineModel } from '@nessie/spreadsheet'

import { batchRejected, spreadsheetNotFound, structuralConflict, tooLarge } from './errors.js'
import { applyDiffs, isEmptyDiffPayload, type SpreadsheetWorkbook } from './engine.js'
import {
  assertEngineMatches,
  hotSnapshotDue,
  loadHead,
  lockSpreadsheetPage,
  modelAtHead,
  sheetNamesOf,
} from './head.js'
import { remapFiltersForBatch } from './filter-model.js'
import {
  toAppliedBatch,
  type SpreadsheetBatchRow,
  type SpreadsheetServiceDeps,
  type SpreadsheetWriteActor,
} from './deps.js'

/**
 * The transactional half of the write door. `apply.ts` wraps it with the
 * version safety net; nothing else calls it, so the lock/idempotency/conflict/
 * seq/audit sequence exists exactly once.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/storage-and-concurrency.md
 */

export type SpreadsheetBatchSource =
  /**
   * A browser batch: opaque diff bytes produced by the client's own engine at
   * `baseSeq`. The only kind that can lose a structural race, because the
   * client built it against a grid the server may have moved since.
   */
  | { kind: 'client'; diffs: Uint8Array; baseSeq: number }
  /**
   * A server batch: the mutation is performed on the model *at head, under the
   * lock*, and its diffs come out of the send queue. Structural conflict is
   * impossible by construction.
   */
  | {
      kind: 'server'
      /**
       * Performs the mutation and returns the summary it actually produced.
       * The helpers in `@nessie/spreadsheet` pause evaluation around their own
       * calls and leave their diffs in the send queue, which is the contract
       * this branch is written against — so nothing here wraps a second pause
       * around them (a nested resume would evaluate mid-batch).
       */
      mutate: (model: SpreadsheetEngineModel) => SpreadsheetBatchSummary | void
    }

export type CommitBatchInput = {
  organizationId: string
  pageId: string
  clientOpId: string
  actor: SpreadsheetWriteActor
  source: SpreadsheetBatchSource
}

export type CommitBatchResult = {
  /** Null only for a no-op: nothing was journalled, so there is nothing to show. */
  batch: SpreadsheetAppliedBatch | null
  /** True when `(pageId, actorId, clientOpId)` already existed: nothing changed. */
  replayed: boolean
  /**
   * True when the payload carried no operations. A drained send queue flushes
   * as one `0x00` byte, so an eager client flushing on every microtask would
   * otherwise burn a `seq`, write a row and wake every pane per keystroke.
   */
  noop: boolean
  headSeq: number
  sheetNames: string[]
}

const AUDIT_ACTION = 'kb.spreadsheet.batch_applied'

/**
 * Every write to one page queues behind that page's advisory lock, so a burst
 * is *expected* to wait rather than to fail. Prisma's defaults (2 s to acquire,
 * 5 s to finish) are sized for a transaction that contends with nothing: with a
 * few dozen panes flushing into the same workbook they turn ordinary
 * contention into a 500, and the client's only recovery is to resubmit — which
 * makes the queue longer.
 *
 * `maxWait` is therefore generous and `timeout` is not: waiting for the lock is
 * normal, holding it for fifteen seconds is not, and the second number is what
 * stops one wedged apply blocking a page indefinitely.
 */
const SPREADSHEET_TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 15_000 } as const

/**
 * Has any batch after `baseSeq` moved the grid under one of the sheets this
 * batch claims to touch?
 *
 * `&&` is Postgres' array-overlap operator; Prisma's query builder has no
 * equivalent, and doing it in JS would mean reading every batch since
 * `baseSeq` on the happy path too.
 */
const crossingStructuralBatch = async (
  tx: Prisma.TransactionClient,
  pageId: string,
  baseSeq: number,
  sheetIndexes: number[],
): Promise<boolean> => {
  if (sheetIndexes.length === 0) return false
  const rows = await tx.$queryRaw<{ exists: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM spreadsheet_op_batches
      WHERE page_id = ${pageId}::uuid
        AND seq > ${BigInt(baseSeq)}
        AND structural_kind IS NOT NULL
        AND sheet_indexes && ${sheetIndexes}::int[]
    ) AS "exists"
  `)
  return rows[0]?.exists === true
}

export const commitSpreadsheetBatch = async (
  deps: SpreadsheetServiceDeps,
  input: CommitBatchInput,
  /**
   * **Caller-supplied and advisory only.** It feeds exactly three things — the
   * structural-conflict check, the filter-model remap and audit/presence text
   * — and is never an input to an authorization, tenancy or permission
   * decision: those are settled by the caller, from the actor context and the
   * page's space, before this function is reached. It is a separate argument
   * precisely so the access layer never has to see it.
   */
  summary: SpreadsheetBatchSummary,
): Promise<CommitBatchResult> => {
  if (input.source.kind === 'client' && isEmptyDiffPayload(input.source.diffs)) {
    const head = await deps.prisma.spreadsheetHead.findFirst({
      where: { pageId: input.pageId, organizationId: input.organizationId },
      select: { headSeq: true, sheetNames: true },
    })
    if (!head) throw spreadsheetNotFound(input.pageId)
    return {
      batch: null,
      replayed: false,
      noop: true,
      headSeq: Number(head.headSeq),
      sheetNames: head.sheetNames,
    }
  }
  if (input.source.kind === 'client' && input.source.diffs.byteLength > SPREADSHEET_LIMITS.maxBatchBytes) {
    throw tooLarge('That change is too large to apply in one batch', {
      bytes: input.source.diffs.byteLength,
      maxBytes: SPREADSHEET_LIMITS.maxBatchBytes,
    })
  }

  const committed = await deps.prisma.$transaction(async (tx) => {
    await lockSpreadsheetPage(tx as never, input.pageId)
    const head = await loadHead(tx as never, input.organizationId, input.pageId)
    assertEngineMatches(head)

    // Idempotency. A browser mints a uuid per batch and a tool uses its
    // toolCallId, so a retried request lands here rather than applying twice.
    const existing = await tx.spreadsheetOpBatch.findFirst({
      where: { pageId: input.pageId, actorId: input.actor.id, clientOpId: input.clientOpId },
    })
    if (existing) {
      return {
        row: existing as unknown as SpreadsheetBatchRow,
        replayed: true,
        noop: false,
        headSeq: Number(head.headSeq),
        sheetNames: head.sheetNames,
        snapshotBytes: null as Uint8Array | null,
      }
    }

    const headSeq = Number(head.headSeq)
    const baseSeq = input.source.kind === 'client' ? input.source.baseSeq : headSeq
    if (input.source.kind === 'client' && baseSeq < headSeq) {
      if (await crossingStructuralBatch(tx, input.pageId, baseSeq, summary.sheetIndexes)) {
        const since = await tx.spreadsheetOpBatch.findMany({
          where: { pageId: input.pageId, seq: { gt: BigInt(baseSeq) } },
          orderBy: { seq: 'asc' },
          take: SPREADSHEET_LIMITS.opsCatchUpPageSize,
        })
        throw structuralConflict(
          input.pageId,
          headSeq,
          since.map((row) => toAppliedBatch(row as unknown as SpreadsheetBatchRow)),
        )
      }
    }

    const workbook = await modelAtHead(deps, tx as never, head)
    let diffs: Uint8Array
    // A server batch derives its own summary from what it actually did; the
    // caller's is advisory and only ever used for the conflict check, which a
    // server batch does not take (it is built at head).
    let effective = summary
    try {
      if (input.source.kind === 'client') {
        applyDiffs(workbook, input.source.diffs)
        diffs = input.source.diffs
      } else {
        // Drain anything a previous caller left behind so this batch carries
        // only its own work.
        workbook.native.flushSendQueue()
        const produced = input.source.mutate(workbook.model)
        if (produced) effective = produced
        diffs = workbook.native.flushSendQueue()
      }
      if (isEmptyDiffPayload(diffs)) {
        // The mutation changed nothing the engine could describe — setting a
        // cell to what it already held, hiding an already-hidden row. There is
        // nothing to journal and nothing to broadcast.
        return {
          row: null,
          replayed: false,
          noop: true,
          headSeq,
          sheetNames: head.sheetNames,
          snapshotBytes: null as Uint8Array | null,
        }
      }
    } catch (error) {
      // The model may hold a partial mutation, and this transaction is about
      // to roll back — the cache must not keep a state no journal describes.
      deps.cache.evict(input.pageId)
      throw batchRejected(input.pageId, error instanceof Error ? error.message : String(error))
    }

    const seq = headSeq + 1
    const sheetNames = sheetNamesOf(workbook)
    const row = await tx.spreadsheetOpBatch.create({
      data: {
        pageId: input.pageId,
        organizationId: input.organizationId,
        seq: BigInt(seq),
        baseSeq: BigInt(baseSeq),
        clientOpId: input.clientOpId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        agentId: input.actor.agentId ?? null,
        runId: input.actor.runId ?? null,
        agentCredentialId: input.actor.agentCredentialId ?? null,
        engineVersion: head.engineVersion,
        diffs: Buffer.from(diffs),
        structuralKind: effective.structuralKind,
        sheetIndexes: effective.sheetIndexes,
        cellCount: effective.cellCount,
        summary: effective as unknown as Prisma.InputJsonValue,
      },
    })

    const snapshotBytes = hotSnapshotDue(head, seq) ? workbook.model.toBytes() : null
    await tx.spreadsheetHead.update({
      where: { pageId: input.pageId },
      data: {
        headSeq: BigInt(seq),
        sheetNames,
        filters: remapFiltersForBatch(head.filters, effective) as Prisma.InputJsonValue,
        batchesSinceSnapshot: { increment: 1 },
        lastOpAt: new Date(),
        ...(snapshotBytes
          ? { hotSnapshot: Buffer.from(snapshotBytes), hotSnapshotSeq: BigInt(seq) }
          : {}),
      },
    })

    const page = await tx.knowledgePage.update({
      where: { id: input.pageId },
      data: { revision: { increment: 1 } },
      select: { projectId: true, teamId: true },
    })

    if (deps.writeAudit) {
      await deps.writeAudit(tx, {
        organizationId: input.organizationId,
        projectId: page.projectId,
        teamId: page.teamId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: AUDIT_ACTION,
        resourceId: input.pageId,
        metadata: {
          seq,
          clientOpId: input.clientOpId,
          structuralKind: effective.structuralKind,
          sheetIndexes: effective.sheetIndexes,
          cellCount: effective.cellCount,
          touched: effective.touched,
          ...(input.actor.agentId ? { agentId: input.actor.agentId } : {}),
          ...(input.actor.runId ? { runId: input.actor.runId } : {}),
          ...(input.actor.agentCredentialId
            ? { agentCredentialId: input.actor.agentCredentialId }
            : {}),
        },
      })
    }

    return {
      row: row as unknown as SpreadsheetBatchRow,
      replayed: false,
      noop: false,
      headSeq: seq,
      sheetNames,
      snapshotBytes,
    }
  }, SPREADSHEET_TRANSACTION_OPTIONS)

  // After COMMIT, outside the lock: the cached model now stands at this seq.
  if (!committed.replayed && !committed.noop) {
    deps.cache.commit(
      input.pageId,
      committed.headSeq,
      committed.snapshotBytes?.byteLength,
    )
  }

  return {
    batch: committed.row
      ? toAppliedBatch(committed.row, { displayName: input.actor.displayName })
      : null,
    replayed: committed.replayed,
    noop: committed.noop,
    headSeq: committed.headSeq,
    sheetNames: committed.sheetNames,
  }
}

export type { SpreadsheetWorkbook }
