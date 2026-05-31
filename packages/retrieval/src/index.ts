export type { CandidateGenerator } from './candidates.js'
export {
  calculateRecencyScore,
  fuseHybridCandidates,
  HYBRID_FUSION_CONFIG,
  reciprocalRankScore,
  type FusedRetrievalResult,
  type FuseHybridCandidatesInput,
  type RankedRetrievalCandidate,
  type RetrievalCandidateBase,
} from './fusion.js'
export {
  markRecallLedgerInjected,
  markRecallLedgerReferenced,
  THOUGHT_RECALL_LEDGER,
  writeRecallLedgerEntries,
  type LoggedRecallLedgerEntry,
  type RecallLedgerDefinition,
  type RecallLedgerEntry,
} from './ledger.js'
export {
  assertScopedContentMapping,
  buildInScopesMembershipAccessSql,
  SCOPED_CONTENT_COLUMN_KEYS,
  THOUGHT_SCOPED_CONTENT_MAPPING,
  type ScopedContentAudienceType,
  type ScopedContentColumnKey,
  type ScopedContentMapping,
  type ScopedContentRecord,
  type ScopedContentSensitivityTier,
  type ScopedContentVisibility,
  type ScopedMembershipAccessSql,
} from './scoped-content.js'
export {
  searchThoughtCandidates,
  searchThoughtCandidatesInScopes,
  type SearchThoughtCandidatesInScopesInput,
  type SearchThoughtCandidatesInput,
  type ThoughtSearchRow,
} from './thoughts.js'
export { toVectorLiteral, type Queryable } from './query.js'
