import {
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_NOTE_MAX,
  AGENT_TODO_TEMPLATE_DESCRIPTION_MAX,
  AGENT_TODO_TEMPLATE_NAME_MAX,
  AgentTodoRecordSchema,
  AgentTodoStatusSchema,
  AgentTodoStepStatusSchema,
  AgentTodoTemplateRecordSchema,
  AgentTodoTemplateStatusSchema,
  AgentTodoTemplateStepKeySchema,
  AgentTodoTemplateStepInputSchema,
} from '@nessie/schemas'
import { z } from 'zod'

const IdSchema = z.string().uuid()
const TemplateNameSchema = z.string().min(1).max(AGENT_TODO_TEMPLATE_NAME_MAX)
const TemplateDescriptionSchema = z
  .string()
  .max(AGENT_TODO_TEMPLATE_DESCRIPTION_MAX)
const TemplateStepInputsSchema = AgentTodoTemplateStepInputSchema.array()
  .min(1)
  .max(AGENT_TODO_MAX_STEPS)

export const AgentTodoAgentParamsSchema = z.object({
  agentId: IdSchema,
}).strict()

export const AgentTodoTemplateParamsSchema = AgentTodoAgentParamsSchema.extend({
  templateId: IdSchema,
}).strict()

export const AgentTodoParamsSchema = AgentTodoAgentParamsSchema.extend({
  todoId: IdSchema,
}).strict()

export const AgentTodoStepParamsSchema = AgentTodoParamsSchema.extend({
  stepKey: AgentTodoTemplateStepKeySchema,
}).strict()

export const ListAgentTodoTemplatesQuerySchema = z.object({
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()

export const CreateAgentTodoTemplateBodySchema = z.object({
  description: TemplateDescriptionSchema.nullable().optional(),
  name: TemplateNameSchema,
  status: AgentTodoTemplateStatusSchema.exclude(['archived']).default('draft'),
  steps: TemplateStepInputsSchema,
}).strict()

export const UpdateAgentTodoTemplateBodySchema = z.object({
  description: TemplateDescriptionSchema.nullable().optional(),
  name: TemplateNameSchema.optional(),
  steps: TemplateStepInputsSchema.optional(),
  version: z.number().int().positive(),
}).strict().refine(
  (body) =>
    body.description !== undefined
    || body.name !== undefined
    || body.steps !== undefined,
  { message: 'At least one template field must be provided.' },
)

export const ListAgentTodosQuerySchema = z.object({
  status: AgentTodoStatusSchema.optional(),
}).strict()

export const CreateAgentTodoBodySchema = z.union([
  z.object({ templateId: IdSchema }).strict(),
  z.object({
    steps: TemplateStepInputsSchema,
    title: TemplateNameSchema,
  }).strict(),
])

export const RunAgentTodoBodySchema = z.object({
  channelId: IdSchema,
}).strict()

export const UpdateAgentTodoStepBodySchema = z.object({
  note: z.string().max(AGENT_TODO_STEP_NOTE_MAX).nullable().optional(),
  status: AgentTodoStepStatusSchema,
}).strict()

export const EmptyAgentTodoBodySchema = z.object({}).strict()

export {
  AgentTodoRecordSchema,
  AgentTodoTemplateRecordSchema,
}
