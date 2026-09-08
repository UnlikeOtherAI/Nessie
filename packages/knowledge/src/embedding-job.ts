import { createHash } from 'node:crypto'

// Queue rows are durable after completion. Include the target embedding model
// so a configuration change can schedule a fresh pass for the same immutable
// page version without unbounded keys from a model name supplied by config.
export const knowledgeEmbeddingJobKey = (
  pageId: string,
  versionId: string,
  embeddingModel: string,
  sourceContentHash?: string | null,
): string => {
  const modelKey = createHash('sha256')
    .update(embeddingModel)
    .update('\0')
    .update(sourceContentHash ?? '')
    .digest('hex')
    .slice(0, 16)
  return `kb-embed:${pageId}:${versionId}:${modelKey}`
}
