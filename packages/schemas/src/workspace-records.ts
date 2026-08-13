import { z } from 'zod'

import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentStatusSchema,
  AgentTriggerTypeSchema,
  SystemChannelTypeSchema,
} from './lifecycle.js'
import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * Records the API returns for channels, agents, and triggers.
 *
 * They live here rather than in `api/src/contracts` because the services that
 * produce them (`@nessie/workspace-admin`) are shared with the worker: the
 * personal assistant creates a channel, an agent, a binding, or a trigger
 * through the very same functions the routes call, so both sides have to agree
 * on the shape those functions return. `api/src/contracts` re-exports them, so
 * routes and admin-facing contracts are unchanged.
 */

export const ChannelRecordSchema = z.object({
  id: ChannelIdSchema,
  label: NonEmptyStringSchema,
  slug: z.string().nullish(),
  type: z.enum(['standard', 'dm']),
  systemChannelType: SystemChannelTypeSchema.optional(),
  dmUserId: UserIdSchema.nullish(),
  // Group DMs are private conversations with multiple human and/or agent
  // recipients. They share the channel storage model, but must be surfaced in
  // Direct messages rather than a project channel list.
  isGroupDm: z.boolean().optional(),
  visibility: z.enum(['public', 'protected', 'private']),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  projectName: NonEmptyStringSchema,
  teamId: TeamIdSchema,
  teamName: NonEmptyStringSchema,
  defaultThreadId: ThreadIdSchema,
  unreadCount: z.number().int().nonnegative(),
  // When the channel's default thread last received a message; null when it has
  // none. Populated on every channel-record emission (list, single read, and
  // post-mutation responses) so a cached list patched from a mutation response
  // never loses a row's recency.
  lastMessageAt: TimestampSchema.nullable(),
  // sp-channels: channel lifecycle fields
  topic: z.string().nullish(),
  description: z.string().nullish(),
  archivedAt: TimestampSchema.nullish(),
  memberRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullish(),
  // Whether the caller has muted notifications for this channel (per-member).
  muted: z.boolean().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>

export const AgentRecordSchema = z.object({
  id: AgentIdSchema,
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  status: AgentStatusSchema,
  agentKind: z.enum(['shared', 'personal_assistant']).optional(),
  systemManaged: z.boolean().optional(),
  surfacePolicy: z.enum(['shared', 'dm_only']).optional(),
  delegationMode: z.enum(['none', 'act_as_requesting_user']).optional(),
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
  lastActivityAt: TimestampSchema,
  systemPrompt: z.string().optional(),
  parentAgentId: AgentIdSchema.nullish(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  // Explicit per-run caps. Absent = every dimension governed by the deployment
  // backstop; `effort` carries no spend meaning (see
  // docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §1).
  runLimits: AgentRunLimitsSchema.optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  avatarAttachmentId: z.string().uuid().nullish(),
  routingProfileId: z.string().uuid().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  channelIds: z.array(ChannelIdSchema),
})
export type AgentRecord = z.infer<typeof AgentRecordSchema>

export const AgentTriggerStatusSchema = z.enum(['active', 'paused', 'error'])
export type AgentTriggerStatus = z.infer<typeof AgentTriggerStatusSchema>

export const AgentTriggerRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: AgentIdSchema.optional(),
  workflowInstallationId: z.string().uuid().optional(),
  type: AgentTriggerTypeSchema,
  status: AgentTriggerStatusSchema,
  enabled: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
  webhookApiKey: z.string().optional(),
  targetChannelId: ChannelIdSchema.optional(),
  targetThreadId: ThreadIdSchema.optional(),
  lastFiredAt: TimestampSchema.optional(),
  nextRunAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type AgentTriggerRecord = z.infer<typeof AgentTriggerRecordSchema>

export const CreateAgentTriggerBodySchema = z.object({
  type: AgentTriggerTypeSchema,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.optional(),
  targetChannelId: ChannelIdSchema.optional(),
  targetThreadId: ThreadIdSchema.optional(),
})
export type CreateAgentTriggerBody = z.infer<typeof CreateAgentTriggerBodySchema>
