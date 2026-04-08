export { getEmbedding } from './embed.js'
export { computeFingerprint } from './fingerprint.js'
export { extractMetadata, type ThoughtMetadata } from './extract-metadata.js'
export { extractReasoning, type ReasoningExtraction } from './extract-reasoning.js'
export { captureThought, type CaptureThoughtInput, type CapturedThought, type CaptureConfig } from './capture.js'
export {
  searchThoughts,
  searchAndLogThoughts,
  SearchEmbeddingError,
  type SearchThoughtsInput,
  type SearchThoughtsOutput,
  type SearchResult,
  type SearchConfig,
  type SearchExecutionConfig,
} from './search.js'
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
