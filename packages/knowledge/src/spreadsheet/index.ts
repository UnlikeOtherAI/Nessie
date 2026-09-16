import { ensureSpreadsheetFormulaTokenizer } from './formula-tokenizer.js'
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
): SpreadsheetServiceDeps & { presenceBudget: PresenceBudget } => {
  // Warm the formula tokenizer for this process. Sort and in-formula replace
  // both degrade *silently* without it — an unshifted reference, a refused
  // replacement — so it is started as early as anything can know the process
  // will touch a spreadsheet, and awaited again at the two call sites that
  // actually need it.
  void ensureSpreadsheetFormulaTokenizer().catch((error: unknown) => {
    console.error('[spreadsheet] formula tokenizer unavailable', error)
  })
  return {
    ...input,
    cache: input.cache ?? createSpreadsheetModelCache(),
    presenceBudget: input.presenceBudget ?? createPresenceBudget(),
  }
}

export {
  describeSpreadsheet,
  findScopeOf,
  findSpreadsheetMatches,
  parseAxisSpan,
  readSpreadsheetGrid,
  resolveRangeArgument,
  resolveSheetIndexByName,
  withSpreadsheetAtHead,
  type FindInput,
  type FindMatch,
  type ReadGridInput,
  type SpreadsheetDescription,
  type SpreadsheetGridRead,
  type SpreadsheetRef,
  type SpreadsheetValueMode,
} from './agent-reads.js'
export {
  formatSpreadsheetRange,
  outcomeOf,
  sendSpreadsheetAction,
  writeSpreadsheetRange,
  type SpreadsheetEditActor,
  type SpreadsheetStyleInput,
  type WriteRangeToolInput,
} from './agent-edits.js'
export {
  manageSpreadsheetTabs,
  structureSpreadsheet,
  type StructureAction,
  type StructureInput,
  type TabsInput,
} from './agent-structure.js'
export {
  runSpreadsheetFilterTool,
  type FilterColumnInput,
  type FilterToolInput,
} from './agent-filters.js'
export {
  listSpreadsheetVersions,
  restoreSpreadsheetVersionForTool,
  saveSpreadsheetVersion,
  type SpreadsheetVersionSummary,
  type VersionActor,
} from './agent-versions.js'
export { ensureSpreadsheetFormulaTokenizer } from './formula-tokenizer.js'
export {
  SHEET_READ_TOOL_IDS,
  SHEET_TOOL_IDS,
  createSpreadsheetForTool,
  runSheetPageTool,
  spreadsheetClientOpId,
  spreadsheetStepOpId,
  toSheetToolRefusal,
  type CreateSheetToolInput,
  type SheetToolContext,
  type SheetToolId,
} from './agent-tools.js'

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
  enableXlsxParsing,
  engineVersion,
  exportXlsxBytes,
  importXlsxBytes,
  isEmptyDiffPayload,
  isXlsxParsingEnabled,
  loadWorkbook,
  pasteBlock,
  recordDiffs,
  withTempDirectory,
  type SpreadsheetWorkbook,
} from './engine.js'
export { migrateSpreadsheetEngine, type EngineMigrateResult } from './engine-migrate.js'
export {
  SpreadsheetEngineError,
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
export {
  SpreadsheetFilterModelSchema,
  SpreadsheetFiltersSchema,
  parseFilters,
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
  completeSpreadsheetImport,
  inspectUpload,
  stageFileConversion,
  stageSpreadsheetImport,
  workbookFromUpload,
  type ImportSpreadsheetInput,
  type ImportSpreadsheetResult,
  type XlsxImportWarning,
} from './import.js'
export { exportSpreadsheet, type ExportFormat, type SpreadsheetExport } from './export.js'
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
  type RestructureInput,
  type SpreadsheetAction,
  type SpreadsheetReplaceResult,
} from './writes.js'
