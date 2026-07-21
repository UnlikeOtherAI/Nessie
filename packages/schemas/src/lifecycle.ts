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

// How much work an agent may put into each run. Scales the agentic-loop run
// budget (iterations / tool calls / wallclock / tokens / cost) and the
// provider `reasoning_effort`. Modeled on OpenAI Codex's reasoning-effort
// levels. `xhigh` is effectively unbounded: the org/team `Budget` gate and the
// loop's repeated-call detection are its only governors.
export const AgentEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh'])
export type AgentEffort = z.infer<typeof AgentEffortSchema>

export const DEFAULT_AGENT_EFFORT: AgentEffort = 'medium'

// OpenAI-compatible providers accept only `low | medium | high` for
// `reasoning_effort` and reject unknown values, so `xhigh` clamps to `high`.
export type ProviderReasoningEffort = 'low' | 'medium' | 'high'

export const reasoningEffortForAgentEffort = (
  effort: AgentEffort,
): ProviderReasoningEffort => (effort === 'xhigh' ? 'high' : effort)

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
