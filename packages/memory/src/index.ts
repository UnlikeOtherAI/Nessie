export { getEmbedding } from './embed.js'
export { computeFingerprint } from './fingerprint.js'
export { extractMetadata, type ThoughtMetadata } from './extract-metadata.js'
export { extractReasoning, type ReasoningExtraction } from './extract-reasoning.js'
export { captureThought, type CaptureThoughtInput, type CapturedThought, type CaptureConfig } from './capture.js'
export {
  captureUserMessageMemory,
  type UserMessageMemoryOrigin,
} from './user-message-memory.js'
export {
  searchThoughts,
  searchAndLogThoughts,
  searchThoughtsInScopes,
  searchAndLogThoughtsInScopes,
  SearchEmbeddingError,
  type SearchThoughtsInput,
  type SearchThoughtsInScopesInput,
  type SearchThoughtsOutput,
  type SearchResult,
  type SearchConfig,
  type SearchExecutionConfig,
} from './search.js'
export {
  resolveAccessibleScopes,
  type AccessibleScopes,
  type ScopeResolutionMode,
  type ResolveAccessibleScopesInput,
} from './scopes.js'
export {
  logRecalls,
  recordRecallSignal,
  markRecallsInjected,
  markRecallsReferenced,
  type RecallLogEntry,
  type LoggedRecall,
  type RecordRecallSignalInput,
} from './recalls.js'
export {
  recordOutcome,
  type RecordOutcomeInput,
  linkThoughts,
  type LinkThoughtsInput,
  getExperienceStats,
  type ExperienceStats,
} from './lifecycle.js'
export { withTransaction } from './transaction.js'
