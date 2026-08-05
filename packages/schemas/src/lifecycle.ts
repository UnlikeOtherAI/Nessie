import { z } from 'zod'

import {
  OrganizationIdSchema,
  ProjectIdSchema,
  TeamIdSchema,
  UserIdSchema,
} from './ids.js'

export const AgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'executing',
  'waiting_approval',
  'error',
  'offline',
])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

export const AgentKindSchema = z.enum(['shared', 'personal_assistant'])
export type AgentKind = z.infer<typeof AgentKindSchema>

export const AgentSurfacePolicySchema = z.enum(['shared', 'dm_only'])
export type AgentSurfacePolicy = z.infer<typeof AgentSurfacePolicySchema>

// How hard the model thinks per turn — maps ONLY to the provider
// `reasoning_effort` (modeled on OpenAI Codex's levels; `xhigh` clamps to
// `high` for OpenAI-compatible providers). Spend/iteration caps are a separate
// concern: `Agent.runLimits` (explicit, optional) and the deployment backstop.
// See docs/plans/2026-08-05-run-budgets-context-and-research-routing.md.
export const AgentEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh'])
export type AgentEffort = z.infer<typeof AgentEffortSchema>

export const DEFAULT_AGENT_EFFORT: AgentEffort = 'medium'

// OpenAI-compatible providers accept only `low | medium | high` for
// `reasoning_effort` and reject unknown values, so `xhigh` clamps to `high`.
export type ProviderReasoningEffort = 'low' | 'medium' | 'high'

export const reasoningEffortForAgentEffort = (
  effort: AgentEffort,
): ProviderReasoningEffort => (effort === 'xhigh' ? 'high' : effort)

// Optional explicit per-run caps stored in `Agent.runLimits`. Every key is
// optional; an absent key means that dimension is governed only by the
// deployment backstop (NESSIE_RUN_BACKSTOP_*). Values are positive integers.
export const AgentRunLimitsSchema = z
  .object({
    maxTokens: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
    maxIterations: z.number().int().positive().optional(),
    maxWallclockMs: z.number().int().positive().optional(),
    maxCostCents: z.number().int().positive().optional(),
  })
  .strict()
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>

export const AgentDelegationModeSchema = z.enum([
  'none',
  'act_as_requesting_user',
])
export type AgentDelegationMode = z.infer<typeof AgentDelegationModeSchema>

export const SystemChannelTypeSchema = z.enum(['personal_assistant', 'external_agent'])
export type SystemChannelType = z.infer<typeof SystemChannelTypeSchema>

export const AgentTriggerTypeSchema = z.enum([
  'manual',
  'scheduled',
  'webhook',
  'event',
  'interval',
])
export type AgentTriggerType = z.infer<typeof AgentTriggerTypeSchema>

/**
 * Authenticated tenant selected when a user creates a scheduled task. PA and
 * other system-owned agents are deliberately not a source of this identity.
 */
export const ScheduledTriggerLaunchOriginSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema,
  userId: UserIdSchema,
})
export type ScheduledTriggerLaunchOrigin = z.infer<
  typeof ScheduledTriggerLaunchOriginSchema
>

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const TaskStatusSchema = z.enum([
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
  'awaiting_approval',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>
