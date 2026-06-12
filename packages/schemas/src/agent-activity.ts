import { z } from 'zod'

import { AgentIdSchema, RunIdSchema, TaskIdSchema, ThreadIdSchema } from './ids.js'
import { AgentStatusSchema, RunStatusSchema } from './lifecycle.js'
import { MessageRoleSchema } from './messaging.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export const ToolCallEntrySchema = z.object({
  toolName: NonEmptyStringSchema,
  runId: RunIdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  success: z.boolean().optional(),
  inputSummary: z.string(),
  outputPreview: z.string().optional(),
})
export type ToolCallEntry = z.infer<typeof ToolCallEntrySchema>

export const AgentStatusResponseSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  since: TimestampSchema,
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
  activeSubAgents: z.array(
    z.object({
      agentId: AgentIdSchema,
      status: AgentStatusSchema,
      taskId: TaskIdSchema,
    }),
  ),
  lastActivityAt: TimestampSchema,
})
export type AgentStatusResponse = z.infer<typeof AgentStatusResponseSchema>

export const AgentActivityResponseSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  currentRun: z
    .object({
      runId: RunIdSchema,
      status: RunStatusSchema,
      startedAt: TimestampSchema,
      toolCalls: z.array(ToolCallEntrySchema),
    })
    .optional(),
  recentToolCalls: z.array(ToolCallEntrySchema),
  subAgents: z.array(
    z.object({
      agentId: AgentIdSchema,
      name: NonEmptyStringSchema,
      status: AgentStatusSchema,
      taskId: TaskIdSchema,
      purpose: z.string().optional(),
    }),
  ),
})
export type AgentActivityResponse = z.infer<typeof AgentActivityResponseSchema>

export const AgentMessageSchema = z.object({
  messageId: NonEmptyStringSchema,
  role: MessageRoleSchema,
  contentPreview: z.string(),
  fullContent: z.string(),
  threadId: ThreadIdSchema,
  timestamp: TimestampSchema,
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const AgentChildSchema = z.object({
  agentId: AgentIdSchema,
  name: NonEmptyStringSchema,
  status: AgentStatusSchema,
  taskId: TaskIdSchema.optional(),
  purpose: z.string().optional(),
  parentAgentId: AgentIdSchema,
  createdAt: TimestampSchema,
})
export type AgentChild = z.infer<typeof AgentChildSchema>
