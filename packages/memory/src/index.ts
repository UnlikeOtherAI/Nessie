export { getEmbedding, type EmbeddingConfig } from './embed.js'
export { computeFingerprint } from './fingerprint.js'
export { extractMetadata, type ThoughtMetadata, type ExtractionConfig } from './extract-metadata.js'
export { extractReasoning, type ReasoningExtraction, type ReasoningExtractionConfig } from './extract-reasoning.js'
export { captureThought, type CaptureThoughtInput, type CapturedThought, type CaptureConfig } from './capture.js'
export {
  searchThoughts,
  SearchEmbeddingError,
  type SearchThoughtsInput,
  type SearchResult,
  type SearchConfig,
} from './search.js'
export {
  recordOutcome,
  type RecordOutcomeInput,
  linkThoughts,
  type LinkThoughtsInput,
  getExperienceStats,
  type ExperienceStats,
} from './lifecycle.js'
