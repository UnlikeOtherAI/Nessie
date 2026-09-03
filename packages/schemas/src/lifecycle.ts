import { z } from 'zod'
import { UoaSessionIdentitySchema } from './access-context.js'

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
  /** Suspended on an interactive card, waiting for a person to press a button. */
  'waiting_input',
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

export const SystemChannelTypeSchema = z.enum([
  'personal_assistant',
  'external_agent',
  // Backing operations room for a hosted agent mailbox: one channel per
  // AgentMailbox, one thread per email conversation.
  'agent_email',
  // The per-user private home DM of a global agent (Agent Designer, ...).
  'system_agent',
])
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
  /**
   * The UOA team the creator was standing in, captured while a real
   * session existed.
   *
   * A fire has no session, and signing a Ledger call needs one: the product
   * account link proves the user's subject, status and credential epoch, but
   * not which UOA team they were acting in — that only a session knows.
   * Without this every scheduled run failed before dispatch with
   * "Ledger requires a linked UnlikeOtherAI SSO identity". It is replayed at
   * fire time and then verified against the link exactly as a live session is,
   * so a revoked link or a rotated credential epoch still fails closed.
   *
   * Optional because triggers created before this existed have none; those
   * keep failing loudly rather than silently signing as somebody else.
   */
  uoaIdentity: UoaSessionIdentitySchema.optional(),
  userId: UserIdSchema,
})
export type ScheduledTriggerLaunchOrigin = z.infer<
  typeof ScheduledTriggerLaunchOriginSchema
>

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  /**
   * Suspended on an interactive card posted with `wait: true`. Non-terminal
   * and holds the (agent, thread) run slot, exactly like `waiting_approval`.
   */
  'waiting_input',
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
