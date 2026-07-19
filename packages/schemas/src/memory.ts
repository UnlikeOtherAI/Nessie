import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  TeamIdSchema,
  ThoughtIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema } from './schema-primitives.js'

// ─── Phase 2: Channel Visibility ───────────────────────────────────────────

export const ChannelVisibilitySchema = z.enum(['public', 'protected', 'private'])
export type ChannelVisibility = z.infer<typeof ChannelVisibilitySchema>

// ─── Memory Schemas ─────────────────────────────────────────────────────────

export const ThoughtVisibilitySchema = z.enum([
  'private',
  'channel',
  'team',
  'project',
  'organization',
])
export type ThoughtVisibility = z.infer<typeof ThoughtVisibilitySchema>

export const ThoughtAudienceTypeSchema = z.enum([
  'user',
  'channel',
  'team',
  'project',
  'organization',
])
export type ThoughtAudienceType = z.infer<typeof ThoughtAudienceTypeSchema>

export const SensitivityTierSchema = z.enum(['normal', 'sensitive', 'restricted'])
export type SensitivityTier = z.infer<typeof SensitivityTierSchema>

export const ReasoningTypeSchema = z.enum([
  'decision',
  'evaluation',
  'constraint',
  'pattern',
  'correction',
  'validation',
])
export type ReasoningType = z.infer<typeof ReasoningTypeSchema>

export const OutcomeStatusSchema = z.enum([
  'pending',
  'successful',
  'partially',
  'failed',
  'superseded',
])
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>

export const ThoughtLinkRelationSchema = z.enum([
  'supersedes',
  'derived_from',
  'contradicts',
  'supports',
  'relates_to',
])
export type ThoughtLinkRelation = z.infer<typeof ThoughtLinkRelationSchema>
export const ThoughtSearchModeSchema = z.enum(['semantic', 'lexical', 'hybrid'])
export type ThoughtSearchMode = z.infer<typeof ThoughtSearchModeSchema>
export const ThoughtRecallUserSignalSchema = z.enum([
  'helpful',
  'irrelevant',
  'harmful',
])
export type ThoughtRecallUserSignal = z.infer<typeof ThoughtRecallUserSignalSchema>

export const CaptureThoughtBodySchema = z.object({
  content: z.string().min(1).max(50000),
  audienceType: ThoughtAudienceTypeSchema.optional(),
  visibility: ThoughtVisibilitySchema.optional(),
  sensitivityTier: SensitivityTierSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
})
export type CaptureThoughtBody = z.infer<typeof CaptureThoughtBodySchema>

export const SearchThoughtsBodySchema = z.object({
  query: z.string().min(1).max(2000),
  threshold: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeReasoning: z.boolean().optional(),
  mode: ThoughtSearchModeSchema.optional(),
})
export type SearchThoughtsBody = z.infer<typeof SearchThoughtsBodySchema>

export const RecordOutcomeBodySchema = z.object({
  outcome: z.enum(['successful', 'partially', 'failed']),
  outcomeNotes: z.string().max(5000).optional(),
})
export type RecordOutcomeBody = z.infer<typeof RecordOutcomeBodySchema>

export const LinkThoughtsBodySchema = z.object({
  targetId: ThoughtIdSchema,
  relation: ThoughtLinkRelationSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type LinkThoughtsBody = z.infer<typeof LinkThoughtsBodySchema>

export const RecordThoughtRecallSignalBodySchema = z.object({
  userSignal: ThoughtRecallUserSignalSchema,
})
export type RecordThoughtRecallSignalBody = z.infer<
  typeof RecordThoughtRecallSignalBodySchema
>

/**
 * Immutable identity captured when a completed user-triggered run schedules
 * post-run memory consolidation. The queue consumer must never reconstruct
 * billable identity from a channel, mutable membership, or message history.
 */
export const MemoryConsolidationInferenceOriginSchema = z.object({
  actorId: AgentIdSchema,
  actorType: z.literal('system'),
  agentId: AgentIdSchema,
  agentKind: z.literal('system'),
  organizationId: OrganizationIdSchema,
  userId: UserIdSchema,
  teamId: TeamIdSchema,
  projectId: ProjectIdSchema.optional(),
  channelId: ChannelIdSchema,
  threadId: ThreadIdSchema,
  taskId: TaskIdSchema,
  runId: RunIdSchema,
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  systemComponent: z.literal('memory-consolidation'),
  toolCallId: NonEmptyStringSchema,
})
export type MemoryConsolidationInferenceOrigin = z.infer<
  typeof MemoryConsolidationInferenceOriginSchema
>

/**
 * Source-run locator and immutable launch scope. The source agent/channel may
 * be a PA system resource, while user/team/project remain the authenticated
 * launch scope used for billing.
 */
export const MemoryConsolidationSourceSchema = z.object({
  agentId: AgentIdSchema,
  organizationId: OrganizationIdSchema,
  userId: UserIdSchema,
  teamId: TeamIdSchema,
  projectId: ProjectIdSchema.optional(),
  channelId: ChannelIdSchema,
  threadId: ThreadIdSchema,
  taskId: TaskIdSchema,
})
export type MemoryConsolidationSource = z.infer<
  typeof MemoryConsolidationSourceSchema
>

export const RunMemoryConsolidateJobPayloadSchema = z
  .object({
    runId: RunIdSchema,
    taskId: TaskIdSchema,
    origin: MemoryConsolidationInferenceOriginSchema,
    source: MemoryConsolidationSourceSchema,
  })
  .superRefine((payload, context) => {
    const requestId = `memory-consolidation:${payload.runId}`
    if (payload.origin.requestId !== requestId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Memory consolidation requestId must be bound to the source run',
        path: ['origin', 'requestId'],
      })
    }
    if (payload.origin.toolCallId !== `${requestId}:capture`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Memory consolidation toolCallId must be bound to the source run',
        path: ['origin', 'toolCallId'],
      })
    }
    if (payload.origin.taskId !== payload.taskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Memory consolidation origin taskId must match the source task',
        path: ['origin', 'taskId'],
      })
    }

    const boundSourceFields = [
      'organizationId',
      'userId',
      'teamId',
      'projectId',
      'channelId',
      'threadId',
      'taskId',
    ] as const
    for (const field of boundSourceFields) {
      if (payload.origin[field] !== payload.source[field]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Memory consolidation origin ${field} must match its source`,
          path: ['origin', field],
        })
      }
    }
  })
export type RunMemoryConsolidateJobPayload = z.infer<
  typeof RunMemoryConsolidateJobPayloadSchema
>
