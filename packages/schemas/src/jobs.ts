import { z } from 'zod'

import { AuthorizedActionContextSchema } from './access-context.js'
import {
  AgentIdSchema,
  ChannelIdSchema,
  RunIdSchema,
  TaskIdSchema,
  ThreadIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export const RunExecuteJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  agentId: AgentIdSchema,
  // True only for a live human conversational turn (a person's chat message and
  // the agent's direct reply). Triggers (even manually fired), subtasks, mailbox,
  // and scheduled runs leave this unset — they are background automation and are
  // subject to budget throttling regardless of who initiated them.
  interactive: z.boolean().optional(),
  messageId: NonEmptyStringSchema,
  parentPlanId: z.string().uuid().optional(),
  parentPlanStepId: z.string().uuid().optional(),
  parentWorkflowRunId: z.string().uuid().optional(),
  parentWorkflowStepRunId: z.string().uuid().optional(),
  promptOverride: z.string().min(1).optional(),
  runId: RunIdSchema,
  taskId: TaskIdSchema,
  threadId: ThreadIdSchema,
})
export type RunExecuteJobPayload = z.infer<typeof RunExecuteJobPayloadSchema>

export const OrchestrateDecideJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  /**
   * Resolved agent list as computed by createThreadMessage — includes bound
   * agents AND any @mentioned agents not yet bound to the channel.
   * Stored in payload so the worker does not re-derive (would miss @mentions).
   */
  channelAgents: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      role: z.string().min(1),
      systemPrompt: z.string().nullable(),
    }),
  ),
  channelId: ChannelIdSchema,
  content: z.string().min(1),
  messageId: z.string().uuid(),
  role: z.string().min(1),
  threadId: ThreadIdSchema,
})
export type OrchestrateDecideJobPayload = z.infer<typeof OrchestrateDecideJobPayloadSchema>

/**
 * `push.dispatch` queue job — emitted by the api right after a message is
 * published to realtime, consumed by the worker to fan APNs/FCM push out to the
 * channel members' registered devices. Ids are plain uuids (not branded) so the
 * worker can use them directly against Prisma. `contentSnippet` is the
 * already-truncated notification body; `mentionUserIds` carries the resolved
 * @mention user ids — mentioned recipients get distinct '<author> mentioned
 * you in <channel>' framing while unmentioned members keep standard framing.
 */
export const PushDispatchJobPayloadSchema = z.object({
  messageId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  channelId: z.string().uuid(),
  threadId: z.string().uuid(),
  organizationId: z.string().uuid(),
  contentSnippet: z.string(),
  mentionUserIds: z.array(z.string().uuid()),
})
export type PushDispatchJobPayload = z.infer<typeof PushDispatchJobPayloadSchema>

/**
 * `budget.alert-dispatch` queue job — emitted by the worker's budget gate when a
 * scope Budget first crosses its warn threshold ('threshold') or first blocks a
 * run ('blocked') in a period. Consumed by the worker to notify org owners and
 * the budget scope's managers through the shared push pipeline (respecting each
 * recipient's push preferences). Durable once-per-period dedupe is enforced by
 * the `budget_alerts` marker row before this job is enqueued; the idempotency
 * key is a second guard. This carries only local ops telemetry — never any UOA
 * credits/statement data.
 */
export const BudgetAlertDispatchJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  scopeType: z.enum(['organization', 'project', 'team']),
  scopeId: z.string().uuid(),
  kind: z.enum(['threshold', 'blocked']),
  period: z.enum(['weekly', 'monthly', 'yearly']),
  scopeLabel: z.string(),
  percentUsed: z.number().nullable(),
  reason: z.string(),
})
export type BudgetAlertDispatchJobPayload = z.infer<typeof BudgetAlertDispatchJobPayloadSchema>

export const WorkflowRunExecuteJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  workflowRunId: z.string().uuid(),
})
export type WorkflowRunExecuteJobPayload = z.infer<typeof WorkflowRunExecuteJobPayloadSchema>

export const PersonalAssistantConfigSummarySchema = z.object({
  agentId: AgentIdSchema,
  model: z.string().optional(),
  provider: z.string().optional(),
  systemPromptPreview: z.string().optional(),
  toolIds: z.array(NonEmptyStringSchema),
  updatedAt: TimestampSchema,
})
export type PersonalAssistantConfigSummary = z.infer<
  typeof PersonalAssistantConfigSummarySchema
>

export const PersonalAssistantBootstrapResponseSchema = z.object({
  agent: z.object({
    id: AgentIdSchema,
    name: z.literal('Personal Assistant'),
  }),
  channel: z.object({
    id: ChannelIdSchema,
    type: z.literal('dm'),
  }),
  thread: z.object({
    id: ThreadIdSchema,
    title: z.string().nullable().optional(),
  }),
  configSummary: PersonalAssistantConfigSummarySchema,
})
export type PersonalAssistantBootstrapResponse = z.infer<
  typeof PersonalAssistantBootstrapResponseSchema
>

export const ExecutionEnvironmentAllocateJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  instanceId: z.string().uuid(),
})
export type ExecutionEnvironmentAllocateJobPayload = z.infer<
  typeof ExecutionEnvironmentAllocateJobPayloadSchema
>

export const ExecutionEnvironmentTerminateJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  instanceId: z.string().uuid(),
})
export type ExecutionEnvironmentTerminateJobPayload = z.infer<
  typeof ExecutionEnvironmentTerminateJobPayloadSchema
>

// `knowledge.embed` queue job — enqueued in the same transaction that chunks a
// knowledge page version, consumed by the worker to fill the version's NULL
// chunk embeddings (copy-by-content-hash first, then batched provider calls).
// Idempotency key: kb-embed:<pageId>:<versionId>.
export const KNOWLEDGE_EMBED_TOPIC = 'knowledge.embed'

export const KnowledgeInferenceOriginSchema = z.object({
  userId: z.string().uuid(),
  teamId: z.string().uuid(),
  agentId: z.string().uuid(),
  runId: z.string().uuid(),
  actorId: NonEmptyStringSchema,
  actorType: z.enum(['user', 'agent', 'service', 'system']),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  systemComponent: NonEmptyStringSchema.optional(),
})
export type KnowledgeInferenceOrigin = z.infer<
  typeof KnowledgeInferenceOriginSchema
>

export const KnowledgeEmbedJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  pageId: z.string().uuid(),
  versionId: z.string().uuid(),
  origin: KnowledgeInferenceOriginSchema,
})
export type KnowledgeEmbedJobPayload = z.infer<typeof KnowledgeEmbedJobPayloadSchema>

// Embedding model for knowledge page chunks. Shared by the worker (chunk
// embedding) and the api (query embedding) — the two sides must agree or
// cosine distances are meaningless. Dims are pinned by the
// knowledge_page_chunks.embedding vector(1536) column.
export const KNOWLEDGE_EMBEDDING_MODEL = 'text-embedding-3-small'
export const KNOWLEDGE_EMBEDDING_DIMS = 1536

// `knowledge.extract` queue job — enqueued whenever a file-node page (or a new
// version of one) is written, consumed by the worker to deterministically pull
// text out of the uploaded blob (plain text / pdf / docx) so file uploads
// become searchable like native documents. This job is stage 1 of the file
// pipeline: extract (this job, writes chunk rows via
// replaceKnowledgePageVersionChunks) -> chunk (same transaction) -> the
// existing knowledge.embed job (enqueued only when chunks were actually
// written) fills in the embeddings. Idempotency key:
// kb-extract:<pageId>:<versionId>.
export const KNOWLEDGE_EXTRACT_TOPIC = 'knowledge.extract'

export const KnowledgeExtractJobPayloadSchema = z.object({
  organizationId: z.string().uuid(),
  pageId: z.string().uuid(),
  versionId: z.string().uuid(),
  attachmentId: z.string().uuid(),
  origin: KnowledgeInferenceOriginSchema,
})
export type KnowledgeExtractJobPayload = z.infer<typeof KnowledgeExtractJobPayloadSchema>

export const TriggerEventDispatchJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  dedupeKey: NonEmptyStringSchema.optional(),
  eventType: NonEmptyStringSchema,
  payload: z.record(z.unknown()),
  source: z.string().min(1),
})
export type TriggerEventDispatchJobPayload = z.infer<typeof TriggerEventDispatchJobPayloadSchema>
