import { SPREADSHEET_LIMITS, type SpreadsheetBatchSummary } from '@nessie/schemas'
import type { LedgerAttribution } from '@nessie/runtime'

import { commitSpreadsheetBatch, type CommitBatchInput, type CommitBatchResult } from './commit.js'
import { createSpreadsheetSnapshot, type SnapshotReason } from './snapshot.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * **The single write door.** Browsers (route), worker builtins and the MCP
 * server all arrive here; nothing else calls `commitSpreadsheetBatch`, so the
 * automatic version cannot be skipped by adding a new caller.
 *
 * Two things happen, in this order:
 *
 * 1. **The safety net.** There is no approval gate on agent writes, so a
 *    version is taken before anything destructive and at an agent run's first
 *    write to a page. The decision reads the batch summary, which is advisory
 *    — a wrong summary costs a missing convenience version, and the compaction
 *    cadence still bounds how much work a restore can lose. It can never cost
 *    an authorization decision: those were settled by the caller before this
 *    function was reached, and the summary is a separate argument precisely so
 *    the access layer never sees it.
 * 2. **The commit**, under the page's advisory lock.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/storage-and-concurrency.md
 */

export type ApplySpreadsheetBatchInput = CommitBatchInput & {
  attribution: LedgerAttribution
  /**
   * Set to skip the automatic pre-write version — used by the snapshot,
   * restore and engine-migrate paths, which take their own version first and
   * would otherwise recurse.
   */
  skipSafetyNet?: boolean
}

export type ApplySpreadsheetBatchResult = CommitBatchResult & {
  /** The version taken before this batch, when one was. */
  safetyNetVersionId: string | null
}

const DESTRUCTIVE_STRUCTURAL_KINDS = new Set([
  'deleteRows',
  'deleteColumns',
  'deleteSheet',
  'moveRows',
  'moveColumns',
  'sort',
])

const deletedSpan = (summary: SpreadsheetBatchSummary): number => {
  let span = 0
  for (const intent of summary.intents ?? []) {
    if (intent.kind === 'deleteRows' || intent.kind === 'deleteColumns') span += intent.count
  }
  return span
}

/**
 * "Destructive" in the sense a person would recognise: something that removes
 * or reorders work rather than adding to it. Deliberately generous — a version
 * costs an xlsx write, and a missing one costs somebody their afternoon.
 */
export const describeDestructiveOperation = (
  summary: SpreadsheetBatchSummary,
): string | null => {
  if (summary.structuralKind && DESTRUCTIVE_STRUCTURAL_KINDS.has(summary.structuralKind)) {
    const span = deletedSpan(summary)
    if (summary.structuralKind.startsWith('delete') && span > 0
      && span < SPREADSHEET_LIMITS.destructiveRowsThreshold
      && summary.structuralKind !== 'deleteSheet') {
      return null
    }
    return summary.structuralKind
  }
  if (summary.cellCount >= SPREADSHEET_LIMITS.destructiveCellsThreshold) {
    return `change to ${summary.cellCount} cells`
  }
  const clearing = (summary.intents ?? []).some((intent) =>
    intent.kind === 'rangeClearAll'
    || intent.kind === 'rangeClearContents')
  return clearing && summary.cellCount >= SPREADSHEET_LIMITS.destructiveCellsThreshold
    ? 'clear'
    : null
}

/** Is this the first write this agent run has made to this page? */
const agentRunFirstWrite = async (
  deps: SpreadsheetServiceDeps,
  pageId: string,
  runId: string,
): Promise<boolean> =>
  (await deps.prisma.spreadsheetOpBatch.count({ where: { pageId, runId } })) === 0

const takeSafetyNetVersion = async (
  deps: SpreadsheetServiceDeps,
  input: ApplySpreadsheetBatchInput,
  summary: SpreadsheetBatchSummary,
): Promise<string | null> => {
  if (input.skipSafetyNet) return null

  let reason: SnapshotReason | null = null
  let comment = ''

  if (input.actor.runId && input.actor.type === 'agent'
    && (await agentRunFirstWrite(deps, input.pageId, input.actor.runId))) {
    reason = 'agent-run-start'
    comment = `before: ${input.actor.displayName} started editing`
  } else {
    const destructive = describeDestructiveOperation(summary)
    if (destructive) {
      reason = 'before-destructive'
      comment = `before: ${destructive}`
    }
  }
  if (!reason) return null

  try {
    const snapshot = await createSpreadsheetSnapshot(deps, {
      organizationId: input.organizationId,
      pageId: input.pageId,
      actor: input.actor,
      attribution: input.attribution,
      reason,
      changeComment: comment,
    })
    return snapshot.versionId
  } catch (error) {
    // A failed convenience version must not fail the edit the person asked
    // for. It is logged rather than swallowed silently: the safety net going
    // quiet is exactly the fact an operator needs to know.
    console.error('[spreadsheet] pre-write version failed', {
      pageId: input.pageId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export const applySpreadsheetBatch = async (
  deps: SpreadsheetServiceDeps,
  input: ApplySpreadsheetBatchInput,
  summary: SpreadsheetBatchSummary,
): Promise<ApplySpreadsheetBatchResult> => {
  const safetyNetVersionId = await takeSafetyNetVersion(deps, input, summary)
  const result = await commitSpreadsheetBatch(deps, input, summary)

  if (!result.replayed && deps.publish) {
    await deps.publish('sheet.ops', {
      pageId: input.pageId,
      organizationId: input.organizationId,
      data: result.batch,
    })
  }

  if (!result.replayed && deps.enqueueCompaction) {
    const head = await deps.prisma.spreadsheetHead.findUnique({
      where: { pageId: input.pageId },
      select: { batchesSinceSnapshot: true },
    })
    if ((head?.batchesSinceSnapshot ?? 0) >= SPREADSHEET_LIMITS.compactEveryBatches) {
      // Housekeeping must never fail a batch that already committed.
      await deps
        .enqueueCompaction({
          pageId: input.pageId,
          organizationId: input.organizationId,
          seq: result.headSeq,
        })
        .catch((error: unknown) => {
          console.error('[spreadsheet] compaction enqueue failed', {
            pageId: input.pageId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
  }

  return { ...result, safetyNetVersionId }
}
