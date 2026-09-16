import { createPresenceBudget, type PresenceBudget } from './presence.js'
import { createSpreadsheetModelCache, type SpreadsheetModelCache } from './model-cache.js'
import type { SpreadsheetServiceDeps } from './deps.js'

/**
 * The spreadsheet service, created **once per process** by the composition
 * root. The model cache and the presence budget are closure state of this
 * factory — module-scope mutable state is banned in `api/src` and `worker/src`
 * (AGENTS.md), and a module-level cache would also make two service instances
 * in one test share a model and hide the cross-replica bug the cache test
 * exists to catch.
 */
export const createSpreadsheetService = (
  input: Omit<SpreadsheetServiceDeps, 'cache'> & {
    cache?: SpreadsheetModelCache
    presenceBudget?: PresenceBudget
  },
): SpreadsheetServiceDeps & { presenceBudget: PresenceBudget } => ({
  ...input,
  cache: input.cache ?? createSpreadsheetModelCache(),
  presenceBudget: input.presenceBudget ?? createPresenceBudget(),
})

export {
  applySpreadsheetBatch,
  describeDestructiveOperation,
  type ApplySpreadsheetBatchInput,
  type ApplySpreadsheetBatchResult,
} from './apply.js'
export {
  commitSpreadsheetBatch,
  type CommitBatchInput,
  type CommitBatchResult,
  type SpreadsheetBatchSource,
} from './commit.js'
export { createSpreadsheetPage, writeSpreadsheetHead, type CreateSpreadsheetPageInput } from './create.js'
export {
  nowOf,
  toAppliedBatch,
  toSpreadsheetActor,
  type SpreadsheetAuditWriter,
  type SpreadsheetEnqueueCompaction,
  type SpreadsheetPublish,
  type SpreadsheetServiceDeps,
  type SpreadsheetWriteActor,
} from './deps.js'
export {
  applyDiffs,
  createEmptyWorkbook,
  engineVersion,
  exportXlsxBytes,
  importXlsxBytes,
  isEmptyDiffPayload,
  loadWorkbook,
  pasteBlock,
  recordDiffs,
  withTempDirectory,
  type SpreadsheetWorkbook,
} from './engine.js'
export { migrateSpreadsheetEngine, type EngineMigrateResult } from './engine-migrate.js'
export {
  SpreadsheetServiceError,
  batchRejected,
  catchUpExpired,
  engineMismatch,
  invalidRequest,
  spreadsheetNotFound,
  structuralConflict,
  tooLarge,
  unsupportedFeature,
} from './errors.js'
export { evaluateFilter, toRuns, type FilterDelta } from './filter-eval.js'
export {
  SpreadsheetFilterModelSchema,
  SpreadsheetFiltersSchema,
  parseFilters,
  rekeyFiltersForSheetChange,
  remapFiltersForBatch,
  type SpreadsheetFilterModel,
  type SpreadsheetFilters,
} from './filter-model.js'
export {
  clearSpreadsheetFilter,
  getSpreadsheetFilters,
  reapplySpreadsheetFilter,
  setSpreadsheetFilter,
  type FilterActor,
  type SetFilterResult,
} from './filters.js'
export { findInWorkbook, replacementFor, type SpreadsheetFindOptions, type SpreadsheetMatch } from './find.js'
export {
  assertEngineMatches,
  hotSnapshotDue,
  loadHead,
  lockSpreadsheetPage,
  modelAtHead,
  type SpreadsheetHeadRow,
} from './head.js'
export {
  SPREADSHEET_IMPORT_LIMITS,
  convertFileToSpreadsheet,
  importSpreadsheet,
  workbookFromUpload,
  type ImportSpreadsheetInput,
  type ImportSpreadsheetResult,
} from './import.js'
export { exportSpreadsheet, renderCsv, type ExportFormat, type SpreadsheetExport } from './export.js'
export {
  createSpreadsheetModelCache,
  type CachedSpreadsheetModel,
  type SpreadsheetModelCache,
} from './model-cache.js'
export {
  createPresenceBudget,
  publishSpreadsheetPresence,
  publishSpreadsheetPresenceLeave,
  requestSpreadsheetPresence,
  type PresenceBudget,
} from './presence.js'
export { PROJECTION_MAX_CHARS, projectWorkbookText } from './projection.js'
export {
  bootstrapSpreadsheet,
  findInSpreadsheet,
  listSpreadsheetBatches,
  readSpreadsheetRange,
  type RangeRead,
} from './reads.js'
export {
  restoreSpreadsheetVersion,
  workbookForVersion,
  type RestoreSpreadsheetInput,
  type RestoreSpreadsheetResult,
} from './restore.js'
export {
  SPREADSHEET_ICALC_MIME,
  SPREADSHEET_XLSX_MIME,
  createSpreadsheetSnapshot,
  type CreateSnapshotInput,
  type SnapshotReason,
  type SnapshotResult,
} from './snapshot.js'
export {
  replaceInSpreadsheet,
  restructureSpreadsheet,
  type ReplaceResult,
  type RestructureAction,
} from './writes.js'
export {
  detectWorkbookFormat,
  inspectXlsx,
  readZipCentralDirectory,
  type XlsxInspection,
  type XlsxWarning,
} from './xlsx-inspect.js'
