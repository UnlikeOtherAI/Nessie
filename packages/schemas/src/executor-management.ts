import { z } from 'zod'
import { PaginationParamsSchema } from './api.js'
import { ImplementedExecutorOperationKeySchema } from './executor.js'
import { AgentVisibilitySchema } from './team-records.js'

export const ExecutorAgentAccessListQuerySchema = PaginationParamsSchema.extend({
  q: z.string().trim().max(200).optional(),
}).strict()
export type ExecutorAgentAccessListQuery = z.infer<typeof ExecutorAgentAccessListQuerySchema>

export const ExecutorAgentAccessRecordSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string(),
  visibility: AgentVisibilitySchema,
  /** Explicit private roster membership; false for project/organisation scopes. */
  assigned: z.boolean(),
  /** Stored grants, not a claim that the machine or all runtime gates are ready. */
  allowedOperationKeys: z.array(ImplementedExecutorOperationKeySchema),
}).strict()
export type ExecutorAgentAccessRecord = z.infer<typeof ExecutorAgentAccessRecordSchema>

export const ExecutorAttentionSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  executors: z.array(z.object({
    executorId: z.string().uuid(),
    policyRevision: z.number().int().positive(),
  }).strict()),
}).strict()
export type ExecutorAttentionSummary = z.infer<typeof ExecutorAttentionSummarySchema>
