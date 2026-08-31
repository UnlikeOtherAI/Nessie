import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  RunIdSchema,
  TaskIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

// Schema-shape bounds live here so every writer and reader shares one contract.
export const AGENT_TODO_MAX_STEPS = 50
export const AGENT_TODO_STEP_KEY_MAX = 64
export const AGENT_TODO_STEP_TITLE_MAX = 200
export const AGENT_TODO_STEP_INSTRUCTIONS_MAX = 2_000
export const AGENT_TODO_STEP_NOTE_MAX = 2_000
export const AGENT_TODO_TEMPLATE_NAME_MAX = 120
export const AGENT_TODO_TEMPLATE_DESCRIPTION_MAX = 500
export const AGENT_TODO_PROMPT_TEMPLATE_LIMIT = 20
export const AGENT_TODO_PROMPT_INSTANCE_LIMIT = 10
export const AGENT_TODO_PROMPT_PROPOSAL_LIMIT = 5
export const AGENT_TODO_PENDING_PROPOSAL_LIMIT = 10
export const AGENT_TODO_APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export const AgentTodoTemplateStatusSchema = z.enum([
  'draft',
  'active',
  'archived',
])
export type AgentTodoTemplateStatus = z.infer<typeof AgentTodoTemplateStatusSchema>

export const AgentTodoStatusSchema = z.enum([
  'open',
  'running',
  'completed',
  'cancelled',
])
export type AgentTodoStatus = z.infer<typeof AgentTodoStatusSchema>

export const AgentTodoStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
])
export type AgentTodoStepStatus = z.infer<typeof AgentTodoStepStatusSchema>

export const AgentTodoActorTypeSchema = z.enum(['user', 'agent'])
export type AgentTodoActorType = z.infer<typeof AgentTodoActorTypeSchema>

export const AgentTodoTemplateStepKeySchema = z
  .string()
  .max(AGENT_TODO_STEP_KEY_MAX)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)

export const AgentTodoTemplateStepSchema = z.object({
  key: AgentTodoTemplateStepKeySchema,
  title: z.string().max(AGENT_TODO_STEP_TITLE_MAX),
  instructions: z.string().max(AGENT_TODO_STEP_INSTRUCTIONS_MAX),
})
export type AgentTodoTemplateStep = z.infer<typeof AgentTodoTemplateStepSchema>

export const AgentTodoTemplateStepInputSchema = AgentTodoTemplateStepSchema.extend({
  key: AgentTodoTemplateStepKeySchema.optional(),
})
export type AgentTodoTemplateStepInput = z.infer<
  typeof AgentTodoTemplateStepInputSchema
>

export const AgentTodoTemplateProposalInputSchema = z.object({
  description: z.string().max(AGENT_TODO_TEMPLATE_DESCRIPTION_MAX).optional(),
  name: z.string().min(1).max(AGENT_TODO_TEMPLATE_NAME_MAX),
  steps: z.array(AgentTodoTemplateStepInputSchema.omit({ key: true }))
    .min(1)
    .max(AGENT_TODO_MAX_STEPS),
}).strict()
export type AgentTodoTemplateProposalInput = z.infer<typeof AgentTodoTemplateProposalInputSchema>

export const AgentTodoTemplateStepsSchema = z
  .array(AgentTodoTemplateStepSchema)
  .min(1)
  .max(AGENT_TODO_MAX_STEPS)
  .superRefine((steps, context) => {
    const stepIndexByKey = new Map<string, number>()

    for (const [index, step] of steps.entries()) {
      const firstIndex = stepIndexByKey.get(step.key)
      if (firstIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate to-do step key: ${step.key}`,
          path: [index, 'key'],
        })
        continue
      }

      stepIndexByKey.set(step.key, index)
    }
  })

const slugifyStepTitle = (title: string): string => {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, AGENT_TODO_STEP_KEY_MAX)
    .replace(/-+$/g, '')

  return slug || 'step'
}

const uniqueStepKey = (baseKey: string, occupiedKeys: ReadonlySet<string>): string => {
  if (!occupiedKeys.has(baseKey)) {
    return baseKey
  }

  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`
    const candidate = `${baseKey.slice(0, AGENT_TODO_STEP_KEY_MAX - suffix.length)}${suffix}`
    if (!occupiedKeys.has(candidate)) {
      return candidate
    }
  }
}

/**
 * Assigns durable step keys without changing the input. Supplied keys are
 * reserved before missing keys are generated, so they remain stable even when
 * a title would otherwise generate the same slug.
 */
export const assignStepKeys = (
  steps: readonly AgentTodoTemplateStepInput[],
): AgentTodoTemplateStep[] => {
  const reservedKeys = new Set(
    steps.flatMap((step) => (step.key === undefined ? [] : [step.key])),
  )
  const assignedKeys = new Set<string>()

  return steps.map((step) => {
    const occupiedKeys = new Set([...reservedKeys, ...assignedKeys])
    const key = step.key
      ?? uniqueStepKey(slugifyStepTitle(step.title), occupiedKeys)

    assignedKeys.add(key)
    return { ...step, key }
  })
}

export const AgentTodoTemplateRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  agentId: AgentIdSchema,
  name: z.string().max(AGENT_TODO_TEMPLATE_NAME_MAX),
  description: z.string().max(AGENT_TODO_TEMPLATE_DESCRIPTION_MAX).nullable(),
  steps: AgentTodoTemplateStepsSchema,
  version: z.number().int().positive(),
  status: AgentTodoTemplateStatusSchema,
  authorType: AgentTodoActorTypeSchema,
  createdByUserId: UserIdSchema.nullable(),
  proposedByRunId: RunIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type AgentTodoTemplateRecord = z.infer<typeof AgentTodoTemplateRecordSchema>

export const AgentTodoStepRecordSchema = z.object({
  id: z.string().uuid(),
  todoId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  key: AgentTodoTemplateStepKeySchema,
  title: z.string().max(AGENT_TODO_STEP_TITLE_MAX),
  instructions: z.string().max(AGENT_TODO_STEP_INSTRUCTIONS_MAX),
  status: AgentTodoStepStatusSchema,
  note: z.string().max(AGENT_TODO_STEP_NOTE_MAX).nullable(),
  updatedByActorType: AgentTodoActorTypeSchema.nullable(),
  updatedByActorId: z.string().uuid().nullable(),
  completedAt: TimestampSchema.nullable(),
})
export type AgentTodoStepRecord = z.infer<typeof AgentTodoStepRecordSchema>

export const AgentTodoRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  agentId: AgentIdSchema,
  templateId: z.string().uuid().nullable(),
  templateVersion: z.number().int().positive().nullable(),
  title: z.string(),
  status: AgentTodoStatusSchema,
  createdByUserId: UserIdSchema.nullable(),
  triggerId: z.string().uuid().nullable(),
  threadId: ThreadIdSchema.nullable(),
  activeRunId: RunIdSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  steps: z.array(AgentTodoStepRecordSchema),
})
export type AgentTodoRecord = z.infer<typeof AgentTodoRecordSchema>

/**
 * Server-authored provenance on the hidden kickoff message for a Run now
 * execution. It is deliberately distinct from `todoRef`, which belongs only
 * on the assistant reply that people can actually see.
 */
export const AgentTodoKickoffMetadataSchema = z.object({
  todoId: z.string().uuid(),
}).strict()

/** One schedule fire represented on a kickoff before its checklist is materialized. */
export const AgentTodoScheduledTemplateRefSchema = z.object({
  templateId: z.string().uuid(),
  triggerId: z.string().uuid(),
}).strict()
export type AgentTodoScheduledTemplateRef = z.infer<typeof AgentTodoScheduledTemplateRefSchema>

/** Provenance on a trigger kickoff before its checklist is materialized. */
export const AgentTodoScheduledKickoffMetadataSchema = z.object({
  todoTemplates: z.array(AgentTodoScheduledTemplateRefSchema).min(1),
}).strict()

export const AgentTodoRunResultSchema = z.object({
  channelId: ChannelIdSchema,
  runId: RunIdSchema.optional(),
  status: z.enum(['queued', 'pended']),
  taskId: TaskIdSchema.optional(),
  threadId: ThreadIdSchema,
})
export type AgentTodoRunResult = z.infer<typeof AgentTodoRunResultSchema>
