import {
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_NOTE_MAX,
  AgentTodoStepStatusSchema,
  AgentTodoTemplateRecordSchema,
  AgentTodoTemplateStepInputSchema,
  AgentTodoTemplateStepKeySchema,
} from '@nessie/schemas'
import {
  startAgentTodoForRun,
  updateAgentTodoStep,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'

const TodoStartInputSchema = z.object({
  steps: z.array(AgentTodoTemplateStepInputSchema)
    .min(1)
    .max(AGENT_TODO_MAX_STEPS)
    .optional(),
  templateId: z.string().uuid().optional(),
  title: AgentTodoTemplateRecordSchema.shape.name.optional(),
  todoId: z.string().uuid().optional(),
}).strict().superRefine((value, issue) => {
  const fromTemplate = value.templateId !== undefined
    && value.todoId === undefined
    && value.title === undefined
    && value.steps === undefined
  const existing = value.templateId === undefined
    && value.todoId !== undefined
    && value.title === undefined
    && value.steps === undefined
  const standalone = value.templateId === undefined
    && value.todoId === undefined
    && value.title !== undefined
    && value.steps !== undefined
  if (!fromTemplate && !existing && !standalone) {
    issue.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Start exactly one to-do: provide templateId, todoId, or both title and steps.',
    })
  }
})

const parseTodoStartInput = (input: Record<string, unknown>) => {
  const parsed = TodoStartInputSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new Error(
    parsed.error.issues[0]?.message
      ?? 'Start exactly one to-do: provide templateId, todoId, or both title and steps.',
  )
}

const TodoStepUpdateInputSchema = z.object({
  note: z.string().max(AGENT_TODO_STEP_NOTE_MAX).optional(),
  status: AgentTodoStepStatusSchema,
  stepKey: AgentTodoTemplateStepKeySchema,
  todoId: z.string().uuid(),
}).strict()

const checklistOutput = (todo: Awaited<ReturnType<typeof startAgentTodoForRun>>): string =>
  JSON.stringify(todo, null, 2)

/**
 * To-do mutations are shared workspace-admin operations. The worker supplies
 * only its immutable run identity, never an agent or run id from model input.
 */
export const runTodoStartTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = parseTodoStartInput(input)
  const identity = {
    agentId: context.agentId,
    organizationId: String(context.channel.organizationId),
    runId: context.run.id,
    threadId: context.run.threadId,
  }
  const todo = args.templateId !== undefined
    ? await startAgentTodoForRun(context.prisma, { ...identity, templateId: args.templateId })
    : args.todoId !== undefined
      ? await startAgentTodoForRun(context.prisma, { ...identity, todoId: args.todoId })
      : await startAgentTodoForRun(context.prisma, {
          ...identity,
          steps: args.steps ?? [],
          title: args.title ?? '',
        })

  return {
    inputSummary: `todoId=${todo.id}`,
    outputPreview: checklistOutput(todo),
    toolName: 'todo_start',
  }
}

export const runTodoStepUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = TodoStepUpdateInputSchema.parse(input)
  const todo = await updateAgentTodoStep(context.prisma, {
    actor: { id: context.agentId, type: 'agent' },
    agentId: context.agentId,
    key: args.stepKey,
    ...(args.note !== undefined ? { note: args.note } : {}),
    organizationId: String(context.channel.organizationId),
    requiredLiveRunId: context.run.id,
    status: args.status,
    todoId: args.todoId,
  })
  return {
    inputSummary: `todoId=${todo.id} stepKey=${args.stepKey}`,
    outputPreview: checklistOutput(todo),
    toolName: 'todo_step_update',
  }
}
