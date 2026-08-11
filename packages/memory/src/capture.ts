import type { LedgerAttribution, ModelClient } from '@nessie/runtime'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import type { ThoughtAudienceType, ThoughtVisibility } from '@nessie/schemas'
import type { Pool } from 'pg'
import { computeFingerprint } from './fingerprint.js'
import { getEmbedding } from './embed.js'
import { extractMetadata, type ThoughtMetadata } from './extract-metadata.js'
import { extractReasoning, type ReasoningExtraction } from './extract-reasoning.js'
import { withTransaction } from './transaction.js'

export type CaptureThoughtInput = {
  content: string
  ownerId: string
  ownerType: 'user' | 'agent' | 'service'
  audienceType?: ThoughtAudienceType
  audienceId?: string
  organizationId: string
  projectId?: string
  teamId?: string
  channelId?: string
  threadId?: string
  userId?: string
  sessionId?: string
  taskId?: string
  runId?: string
  agentId?: string
  agentKind?: 'personal_assistant' | 'shared' | 'system'
  actorId?: string
  actorType?: 'user' | 'agent' | 'service' | 'system'
  requestId?: string
  correlationId?: string
  systemComponent?: string
  toolCallId?: string
  inferenceAttribution?: LedgerAttribution
  visibility?: 'private' | 'channel' | 'team' | 'project' | 'organization'
  sensitivityTier?: 'normal' | 'sensitive' | 'restricted'
  memoryType?: ThoughtMemoryType
  memoryCategory?: ThoughtMemoryCategory
  importance?: number
  metadata?: Record<string, unknown>
  // When set, only this agent may recall the memory. The audience still
  // governs user-level access; this only narrows recall to the owning agent.
  privateToAgentId?: string
}

export type ThoughtMemoryType = 'episodic' | 'semantic' | 'procedural'

export type ThoughtMemoryCategory =
  | 'intent'
  | 'reason'
  | 'constraint'
  | 'preference'
  | 'fact'

export type CapturedThought = {
  id: string
  content: string
  contentHash: string
  metadata: ThoughtMetadata | null
  reasoning: ReasoningExtraction | null
  memoryType: ThoughtMemoryType
  memoryCategory: ThoughtMemoryCategory
  isDuplicate: boolean
  embeddingFailed: boolean
  createdAt: string
}

export type CaptureConfig = {
  pool: Pool
  modelClient: ModelClient
}

const AUDIENCE_TYPE_BY_VISIBILITY: Record<ThoughtVisibility, ThoughtAudienceType> = {
  private: 'user',
  channel: 'channel',
  team: 'team',
  project: 'project',
  organization: 'organization',
}

const VISIBILITY_BY_AUDIENCE_TYPE: Record<ThoughtAudienceType, ThoughtVisibility> = {
  user: 'private',
  channel: 'channel',
  team: 'team',
  project: 'project',
  organization: 'organization',
}


const CATEGORY_BY_METADATA_TYPE: Record<ThoughtMetadata['type'], ThoughtMemoryCategory> = {
  constraint: 'constraint',
  decision: 'intent',
  idea: 'intent',
  note: 'fact',
  observation: 'fact',
  preference: 'preference',
  task: 'intent',
}

const resolveMemoryCategory = (
  input: CaptureThoughtInput,
  metadata: ThoughtMetadata | null,
): ThoughtMemoryCategory =>
  input.memoryCategory ?? (
    metadata ? CATEGORY_BY_METADATA_TYPE[metadata.type] : 'fact'
  )

const resolveCanonicalAudienceId = (
  explicitAudienceId: string | undefined,
  canonicalAudienceId: string | undefined,
  label: string,
): string => {
  if (canonicalAudienceId && explicitAudienceId && canonicalAudienceId !== explicitAudienceId) {
    throw new Error(`${label} memory received conflicting audience identifiers`)
  }

  const audienceId = canonicalAudienceId ?? explicitAudienceId
  if (!audienceId) {
    throw new Error(`${label} memory requires a concrete audience ID`)
  }

  return audienceId
}

const resolveAudience = (
  input: CaptureThoughtInput,
): { audienceId: string; audienceType: ThoughtAudienceType; userId: string | null } => {
  const audienceType = input.audienceType
    ?? AUDIENCE_TYPE_BY_VISIBILITY[input.visibility ?? 'private']

  switch (audienceType) {
    case 'user': {
      const userId = resolveCanonicalAudienceId(
        input.audienceId,
        input.userId ?? (input.ownerType === 'user' ? input.ownerId : undefined),
        'User-scoped',
      )

      return {
        audienceType,
        audienceId: userId,
        userId,
      }
    }
    case 'channel': {
      const audienceId = resolveCanonicalAudienceId(
        input.audienceId,
        input.channelId,
        'Channel-scoped',
      )

      return { audienceType, audienceId, userId: null }
    }
    case 'team': {
      const audienceId = resolveCanonicalAudienceId(
        input.audienceId,
        input.teamId,
        'Team-scoped',
      )

      return { audienceType, audienceId, userId: null }
    }
    case 'project': {
      const audienceId = resolveCanonicalAudienceId(
        input.audienceId,
        input.projectId,
        'Project-scoped',
      )

      return { audienceType, audienceId, userId: null }
    }
    case 'organization':
      return {
        audienceType,
        audienceId: resolveCanonicalAudienceId(
          input.audienceId,
          input.organizationId,
          'Organization-scoped',
        ),
        userId: null,
      }
  }
}

// Attribution for the embedding/extraction model calls. Ordinary captures
// derive it from the memory owner/scope; durable background jobs provide an
// immutable inferenceAttribution so storage scope cannot replace billing scope.
const buildCaptureAttribution = (input: CaptureThoughtInput): LedgerAttribution =>
  input.inferenceAttribution ?? ({
    organizationId: input.organizationId,
    userId:
      input.userId
      ?? (input.ownerType === 'user' ? input.ownerId : null),
    projectId: input.projectId ?? null,
    teamId: input.teamId ?? null,
    channelId: input.channelId ?? null,
    threadId: input.threadId ?? null,
    sessionId: input.sessionId ?? null,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    actorId: input.actorId ?? input.ownerId,
    actorType: input.actorType ?? input.ownerType,
    agentId:
      input.agentId
      ?? input.privateToAgentId
      ?? (input.ownerType === 'agent' ? input.ownerId : null),
    agentKind: input.agentKind ?? null,
    requestId: input.requestId ?? null,
    correlationId: input.correlationId ?? null,
    systemComponent: input.systemComponent ?? 'memory-capture',
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  })

export const captureThought = async (
  input: CaptureThoughtInput,
  config: CaptureConfig,
): Promise<CapturedThought> => {
  const contentHash = computeFingerprint(input.content)
  const resolvedAudience = resolveAudience(input)
  const visibility = VISIBILITY_BY_AUDIENCE_TYPE[resolvedAudience.audienceType]

  // Check for duplicate
  const dupCheck = await config.pool.query(
    `SELECT id, metadata FROM thoughts
     WHERE content_hash = $1
       AND organization_id = $2
       AND deleted_at IS NULL
       AND resolve_thought_audience_type(
         audience_type,
         visibility,
         owner_type,
         owner_id,
         user_id,
         organization_id,
         project_id,
         team_id,
         channel_id
       ) = $3::"ThoughtAudienceType"
       AND resolve_thought_audience_id(
         audience_id,
         resolve_thought_audience_type(
           audience_type,
           visibility,
           owner_type,
           owner_id,
           user_id,
           organization_id,
           project_id,
           team_id,
           channel_id
         ),
         organization_id,
         project_id,
         team_id,
         channel_id,
         user_id,
         owner_type,
         owner_id
       ) = $4::uuid
       AND private_to_agent_id IS NOT DISTINCT FROM $5::uuid
     LIMIT 1`,
    [
      contentHash,
      input.organizationId,
      resolvedAudience.audienceType,
      resolvedAudience.audienceId,
      input.privateToAgentId ?? null,
    ],
  )

  const dupRow = dupCheck.rows[0] as { id: string; metadata: unknown } | undefined
  if (dupRow) {
    const existingMetadata = dupRow.metadata as ThoughtMetadata | null
    const memoryType = input.memoryType ?? 'semantic'
    const memoryCategory = resolveMemoryCategory(input, existingMetadata)

    return {
      id: dupRow.id,
      content: input.content,
      contentHash,
      metadata: existingMetadata,
      reasoning: null,
      memoryType,
      memoryCategory,
      isDuplicate: true,
      embeddingFailed: false,
      createdAt: '',
    }
  }

  // Bill the embedding + extraction LLM calls to the memory's owner/scope.
  const usage = buildCaptureAttribution(input)

  // Run embedding + metadata extraction + reasoning extraction in parallel
  const [embedding, metadata, reasoning] = await Promise.all([
    getEmbedding(input.content, config.modelClient, usage).catch(() => null),
    extractMetadata(input.content, config.modelClient, usage).catch(() => null),
    extractReasoning(input.content, config.modelClient, usage).catch(() => null),
  ])
  const mergedMetadata =
    metadata || input.metadata
      ? ({
          ...(metadata ?? {}),
          ...(input.metadata ?? {}),
        } as ThoughtMetadata)
      : null

  // Insert thought
  const sensitivityTier = input.sensitivityTier ?? 'normal'
  const memoryType = input.memoryType ?? 'semantic'
  const memoryCategory = resolveMemoryCategory(input, mergedMetadata)
  const importance = input.importance ?? 0.5

  return withTransaction(config.pool, async (client) => {
    const insertResult = await client.query(
      `INSERT INTO thoughts (
        id, content, content_hash, embedding, owner_id, owner_type,
        audience_type, audience_id,
        organization_id, project_id, team_id, channel_id, thread_id, user_id,
        visibility, sensitivity_tier, importance, metadata,
        private_to_agent_id, embedding_model, dims, memory_type, memory_category,
        created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3::vector, $4, $5,
        $6::"ThoughtAudienceType", $7::uuid,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18::uuid, $19, $20, $21::"ThoughtMemoryType", $22::"ThoughtMemoryCategory",
        now(), now()
      ) RETURNING id, created_at`,
      [
        input.content,
        contentHash,
        embedding ? `[${embedding.join(',')}]` : null,
        input.ownerId,
        input.ownerType,
        resolvedAudience.audienceType,
        resolvedAudience.audienceId,
        input.organizationId,
        input.projectId ?? null,
        input.teamId ?? null,
        input.channelId ?? null,
        input.threadId ?? null,
        resolvedAudience.userId,
        visibility,
        sensitivityTier,
        importance,
        mergedMetadata ? JSON.stringify(mergedMetadata) : null,
        input.privateToAgentId ?? null,
        embedding ? config.modelClient.embeddingModel : null,
        embedding ? EMBEDDING_DIMENSIONS : null,
        memoryType,
        memoryCategory,
      ],
    )

    const row = insertResult.rows[0] as { id: string; created_at: string }
    const thoughtId = row.id
    const createdAt = row.created_at

    // If reasoning was extracted, insert a ThoughtReasoning record
    if (reasoning?.hasReasoning) {
      await client.query(
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
    await client.query(
      `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, created_at)
       VALUES (gen_random_uuid(), $1, 'created', $2, $3, now())`,
      [thoughtId, input.ownerType, input.ownerId],
    )

    return {
      id: thoughtId,
      content: input.content,
      contentHash,
      metadata: mergedMetadata,
      reasoning,
      memoryType,
      memoryCategory,
      isDuplicate: false,
      embeddingFailed: embedding === null,
      createdAt: String(createdAt),
    }
  })
}
