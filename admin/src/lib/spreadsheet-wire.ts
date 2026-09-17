import type { SpreadsheetAppliedBatch, SpreadsheetBatchSummary } from '@nessie/schemas'

/**
 * The two shapes the spreadsheet sync engine and the live-lane facade both
 * speak: what goes to the write door, and what comes back.
 *
 * They live in `lib/` rather than beside the sync engine because the facade
 * needs them too, and a facade may not import a component
 * (`scripts/lint-admin-layers.mjs`). The rule is worth keeping here rather
 * than allowlisting: these are wire shapes, not rendering concerns, and
 * putting them under the component made the only file that performs the
 * request depend on the file that decides what to do with the answer.
 */

export type OutgoingBatch = {
  clientOpId: string
  baseSeq: number
  /** Base64, as the write door takes it. */
  diffs: string
  summary: SpreadsheetBatchSummary
  /**
   * Calls this batch made that the contract has no intent shape for
   * (`intentFromCall` returned null). Such a batch ships its diffs perfectly
   * well but cannot be replayed, so a structural refusal drops it and says so
   * rather than re-issuing a partial edit.
   */
  unrebasableCalls: number
}

export type SubmitOutcome =
  | { kind: 'applied'; batch: SpreadsheetAppliedBatch; safetyNetVersionId?: string }
  /** The door took the request and numbered nothing: an empty payload, or a
   *  retry the idempotency key had already answered. */
  | { kind: 'noop'; headSeq: number }
  /** The write door refused: somebody moved the rows under this batch. */
  | { kind: 'conflict'; headSeq: number; since: SpreadsheetAppliedBatch[] }
  /** The request never reached a verdict — retry when the lane is back. */
  | { kind: 'offline' }
  /** A verdict this batch cannot recover from (too large, engine refusal). */
  | { kind: 'refused'; message: string }
  /** The page's head is on another engine build: read-only until it rebuilds. */
  | { kind: 'engine-mismatch' }
