import { z } from 'zod'

import { AgentEffortSchema, AgentRunLimitsSchema } from './lifecycle.js'
import { AgentOwnerSchema, AgentVisibilitySchema } from './workspace-records.js'

/**
 * What a Nessie-managed agent *is*, for a reader who may look but not touch.
 *
 * A global agent was list-only: `isAgentVisibleToUser` hard-codes
 * `systemManaged: false`, so every `/api/agents/:id/*` read 404s and "you
 * cannot edit this" read as "this is broken". This is the narrow config read
 * that fixes it (D7) — deliberately NOT a widening of
 * `isAgentAccessibleToActor`, which gates status, activity, messages and
 * children. The Agent Designer is an organisation-wide singleton whose activity
 * spans every member's private DM; its operational reads stay closed.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D4, D7).
 */

export const AgentConfigProjectionSchema = z.object({
  agentKind: z.enum(['shared', 'personal_assistant']).optional(),
  effort: AgentEffortSchema.optional(),
  id: z.string().uuid(),
  model: z.string().optional(),
  name: z.string(),
  owner: AgentOwnerSchema.nullable(),
  provider: z.string().optional(),
  role: z.string(),
  runLimits: AgentRunLimitsSchema.optional(),
  systemManaged: z.boolean(),
  systemPrompt: z.string().optional(),
  todosEnabled: z.boolean(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  visibility: AgentVisibilitySchema,
})
export type AgentConfigProjectionRecord = z.infer<typeof AgentConfigProjectionSchema>

export const ResolvedAgentToolSchema = z.object({
  group: z.string(),
  key: z.string(),
  label: z.string(),
  /**
   * `policy` — this agent's own `toolPolicy` switched it on; `default` — it is
   * a deny-mode builtin nothing has removed; `reserved` — it is a
   * blueprint-declared tool only this built-in specialist may exercise, and
   * only inside its own conversation.
   */
  source: z.enum(['default', 'policy', 'reserved']),
})
export type ResolvedAgentTool = z.infer<typeof ResolvedAgentToolSchema>

export const AgentConfigViewSchema = z.object({
  config: AgentConfigProjectionSchema,
  /** The blueprint slug when this is a global agent, else null. */
  systemSlug: z.string().nullable(),
  tools: z.array(ResolvedAgentToolSchema),
})
export type AgentConfigView = z.infer<typeof AgentConfigViewSchema>
