import { SPREADSHEET_ERROR_CODES, type SpreadsheetAppliedBatch } from '@nessie/schemas'

/**
 * The failure vocabulary the write door and the read paths share, carrying the
 * status a route should send and whatever the client needs to recover. Routes
 * map one class instead of re-deriving a status from a message.
 */
export class SpreadsheetServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'SpreadsheetServiceError'
  }
}

export const spreadsheetNotFound = (pageId: string): SpreadsheetServiceError =>
  new SpreadsheetServiceError(
    'SPREADSHEET_NOT_FOUND',
    404,
    'This page is not a spreadsheet',
    { pageId },
  )

/**
 * The page's head is encoded with an engine this process cannot read. Writes
 * are refused until `spreadsheet.engine-migrate` rebuilds it from the xlsx
 * version — a blue-green swap is safe because of this, not in spite of it.
 */
export const engineMismatch = (
  pageId: string,
  headEngineVersion: string,
  expected: string,
): SpreadsheetServiceError =>
  new SpreadsheetServiceError(
    SPREADSHEET_ERROR_CODES.engineMismatch,
    409,
    'This spreadsheet is being upgraded to a new engine version and is read-only',
    { pageId, headEngineVersion, engineVersion: expected },
  )

/**
 * The only conflict a client has to handle. The client cannot transform bytes,
 * so it replays intent: it is handed every batch since its `baseSeq` and
 * re-issues its recorded intents with indexes shifted by the foreign
 * structural batches (`realtime-and-presence.md` rule 4).
 */
export const structuralConflict = (
  pageId: string,
  headSeq: number,
  since: SpreadsheetAppliedBatch[],
): SpreadsheetServiceError =>
  new SpreadsheetServiceError(
    SPREADSHEET_ERROR_CODES.structuralConflict,
    409,
    'The row or column structure changed while you were editing',
    { pageId, headSeq, since },
  )

export const batchRejected = (pageId: string, reason: string): SpreadsheetServiceError =>
  new SpreadsheetServiceError(
    SPREADSHEET_ERROR_CODES.batchRejected,
    400,
    'The spreadsheet engine refused this change',
    { pageId, reason },
  )

export const catchUpExpired = (pageId: string, afterSeq: number): SpreadsheetServiceError =>
  new SpreadsheetServiceError(
    'SPREADSHEET_CATCHUP_EXPIRED',
    410,
    'Those changes are past retention; reload the spreadsheet',
    { pageId, afterSeq },
  )

export const tooLarge = (message: string, details: Record<string, unknown> = {}): SpreadsheetServiceError =>
  new SpreadsheetServiceError(SPREADSHEET_ERROR_CODES.tooLarge, 413, message, details)

export const unsupportedFeature = (
  message: string,
  details: Record<string, unknown> = {},
): SpreadsheetServiceError =>
  new SpreadsheetServiceError(SPREADSHEET_ERROR_CODES.unsupportedFeature, 415, message, details)

export const invalidRequest = (
  message: string,
  details: Record<string, unknown> = {},
): SpreadsheetServiceError =>
  new SpreadsheetServiceError('SPREADSHEET_INVALID_REQUEST', 400, message, details)
