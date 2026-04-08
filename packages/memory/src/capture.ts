import type { Pool } from 'pg'
import { computeFingerprint } from './fingerprint.js'
import { getEmbedding, type EmbeddingConfig } from './embed.js'
import { extractMetadata, type ThoughtMetadata, type ExtractionConfig } from './extract-metadata.js'
import { extractReasoning, type ReasoningExtraction, type ReasoningExtractionConfig } from './extract-reasoning.js'

export type CaptureThoughtInput = {
  content: string
  ownerId: string
  ownerType: 'user' | 'agent' | 'service'
  organizationId: string
  projectId?: string
  teamId?: string
  channelId?: string
  threadId?: string
  visibility?: 'private' | 'channel' | 'team' | 'project' | 'organization'
  sensitivityTier?: 'normal' | 'sensitive' | 'restricted'
  importance?: number
}

export type CapturedThought = {
  id: string
  content: string
  contentHash: string
  metadata: ThoughtMetadata | null
  reasoning: ReasoningExtraction | null
  isDuplicate: boolean
  embeddingFailed: boolean
  createdAt: string
}

export type CaptureConfig = {
  pool: Pool
  embedding: EmbeddingConfig
  extraction: ExtractionConfig
}

export const captureThought = async (
  input: CaptureThoughtInput,
  config: CaptureConfig,
): Promise<CapturedThought> => {
  const contentHash = computeFingerprint(input.content)

  // Check for duplicate
  const dupCheck = await config.pool.query(
    `SELECT id, metadata FROM thoughts
     WHERE content_hash = $1 AND organization_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [contentHash, input.organizationId],
  )

  const dupRow = dupCheck.rows[0] as { id: string; metadata: unknown } | undefined
  if (dupRow) {
    return {
      id: dupRow.id,
      content: input.content,
      contentHash,
      metadata: dupRow.metadata as ThoughtMetadata | null,
      reasoning: null,
      isDuplicate: true,
      embeddingFailed: false,
      createdAt: '',
    }
  }

  // Run embedding + metadata extraction + reasoning extraction in parallel
  const [embedding, metadata, reasoning] = await Promise.all([
    getEmbedding(input.content, config.embedding).catch(() => null),
    extractMetadata(input.content, config.extraction).catch(() => null),
    extractReasoning(input.content, config.extraction as ReasoningExtractionConfig).catch(() => null),
  ])

  // Insert thought
  const visibility = input.visibility ?? 'private'
  const sensitivityTier = input.sensitivityTier ?? 'normal'
  const importance = input.importance ?? 0.5

  const insertResult = await config.pool.query(
    `INSERT INTO thoughts (
      id, content, content_hash, embedding, owner_id, owner_type,
      organization_id, project_id, team_id, channel_id, thread_id,
      visibility, sensitivity_tier, importance, metadata, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), $1, $2, $3::vector, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, now(), now()
    ) RETURNING id, created_at`,
    [
      input.content,
      contentHash,
      embedding ? `[${embedding.join(',')}]` : null,
      input.ownerId,
      input.ownerType,
      input.organizationId,
      input.projectId ?? null,
      input.teamId ?? null,
      input.channelId ?? null,
      input.threadId ?? null,
      visibility,
      sensitivityTier,
      importance,
      metadata ? JSON.stringify(metadata) : null,
    ],
  )

  const row = insertResult.rows[0] as { id: string; created_at: string }
  const thoughtId = row.id
  const createdAt = row.created_at

  // If reasoning was extracted, insert a ThoughtReasoning record
  if (reasoning?.hasReasoning) {
    await config.pool.query(
      `INSERT INTO thought_reasonings (
        id, thought_id, reasoning_type, alternatives, criteria, constraints,
        tradeoffs, confidence, reasoning, actor_type, actor_id, outcome,
        organization_id, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, 'pending',
        $11, now(), now()
      )`,
      [
        thoughtId,
        reasoning.reasoningType,
        reasoning.alternatives ? JSON.stringify(reasoning.alternatives) : null,
        reasoning.criteria ? JSON.stringify(reasoning.criteria) : null,
        reasoning.constraints ? JSON.stringify(reasoning.constraints) : null,
        reasoning.tradeoffs,
        reasoning.confidence,
        reasoning.reasoningSummary,
        input.ownerType,
        input.ownerId,
        input.organizationId,
      ],
    )
  }

  // Write audit log
  await config.pool.query(
    `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, created_at)
     VALUES (gen_random_uuid(), $1, 'created', $2, $3, now())`,
    [thoughtId, input.ownerType, input.ownerId],
  )

  return {
    id: thoughtId,
    content: input.content,
    contentHash,
    metadata,
    reasoning,
    isDuplicate: false,
    embeddingFailed: embedding === null,
    createdAt: String(createdAt),
  }
}
