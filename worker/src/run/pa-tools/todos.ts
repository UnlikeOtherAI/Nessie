import { randomUUID } from 'node:crypto'
import {
  AGENT_TODO_APPROVAL_EXPIRY_MS,
  AGENT_TODO_PENDING_PROPOSAL_LIMIT,
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_NOTE_MAX,
  AgentTodoStepStatusSchema,
  AgentTodoTemplateRecordSchema,
  AgentTodoTemplateProposalInputSchema,
  AgentTodoTemplateStepInputSchema,
  AgentTodoTemplateStepKeySchema,
} from '@nessie/schemas'
import {
  acquireAgentTodoAgentLock,
  createAgentTodoTemplate,
  startAgentTodoForRun,
  updateAgentTodoStep,
  publishAgentTodoUpdated,
} from '@nessie/team-admin'
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

const PROPOSAL_RESTRICTED_MESSAGE =
  'This conversation drew on restricted material — a person should author this template, or ask me again in a clean conversation.'

/**
 * A template is visible to every agent viewer before approval. It cannot carry
 * a per-run disclosure basis, so any scoped source makes this write fail closed
 * (docs/plans/2026-08-31-agent-todos.md §5).
 */
export const runTodoTemplateProposeTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AgentTodoTemplateProposalInputSchema.parse(input)
  if ((context.consumedSources?.size() ?? 0) > 0) {
    throw new Error(PROPOSAL_RESTRICTED_MESSAGE)
  }
  const organizationId = String(context.channel.organizationId)
  const approval = await context.prisma.$transaction(async (tx) => {
    // Equivalent proposals have no stable dedupe id, so lock and count the
    // pending set itself rather than trusting the model to stop at ten.
    await acquireAgentTodoAgentLock(tx, context.agentId)
    const pending = await tx.approvalRequest.count({
      where: {
        action: 'agent.todo_template.publish',
        agentId: context.agentId,
        organizationId,
        status: 'pending',
      },
    })
    if (pending >= AGENT_TODO_PENDING_PROPOSAL_LIMIT) {
      throw new Error('This agent already has 10 to-do template proposals awaiting review.')
    }
    const template = await createAgentTodoTemplate(tx, {
      agentId: context.agentId,
      authorType: 'agent',
      createdByUserId: null,
      description: args.description,
      name: args.name,
      organizationId,
      proposedByRunId: context.run.id,
      status: 'draft',
      steps: args.steps,
    })
    // Approval visibility can include a member. The required role is what
    // mirrors the owner-only direct template-authoring route.
    return tx.approvalRequest.create({
      data: {
        action: 'agent.todo_template.publish',
        agentId: context.agentId,
        channelId: context.channel.id,
        context: { templateId: template.id, version: template.version },
        continuationToken: randomUUID(),
        expiresAt: new Date(Date.now() + AGENT_TODO_APPROVAL_EXPIRY_MS),
        organizationId,
        reason: `Agent-proposed to-do template: ${template.name}`,
        requesterId: context.agentId,
        requiredApproverRole: 'owner',
        runId: context.run.id,
        status: 'pending',
      },
      select: { id: true },
    })
  })
  return {
    inputSummary: `template=${JSON.stringify(args.name)}`,
    outputPreview: `Template proposal submitted for owner review (approval ${approval.id}).`,
    toolName: 'todo_template_propose',
  }
}

/**
 * To-do mutations are shared team-admin operations. The worker supplies
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

  await publishAgentTodoUpdated(
    context.realtimeTransport,
    {
      agentId: context.agentId,
      organizationId: String(context.channel.organizationId),
      todoId: todo.id,
    },
  )

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
  await publishAgentTodoUpdated(
    context.realtimeTransport,
    {
      agentId: context.agentId,
      organizationId: String(context.channel.organizationId),
      todoId: todo.id,
    },
  )
  return {
    inputSummary: `todoId=${todo.id} stepKey=${args.stepKey}`,
    outputPreview: checklistOutput(todo),
    toolName: 'todo_step_update',
  }
}
