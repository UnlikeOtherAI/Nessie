import { z } from 'zod'

import { AgentEffortSchema, AgentRunLimitsSchema } from './lifecycle.js'
import { AgentOwnerSchema, AgentVisibilitySchema } from './team-records.js'

/**
 * What a Nessie-managed agent *is*, for a reader who may look but not touch.
 *
 * `isAgentVisibleToUser` hard-codes `systemManaged: false`, so a global agent's
 * operational reads (status, activity, messages, children) 404 on it
 * deliberately: it is an organisation-wide singleton whose activity spans every
 * member's private DM. Its configuration is not operational, and this is the
 * shape of that half — produced by `readAgentRecordForActor`, consumed by the
 * `agent_read` assistant tool.
 *
 * The admin does not fetch it: the agent detail page renders a global agent
 * through the ordinary Agent Designer form, disabled, seeded from the entitled
 * agent list it already holds.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D4).
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
