import { openApprovalCard } from '../approval-card.js'
import {
  AGENT_TODO_APPROVAL_EXPIRY_MS,
  AGENT_TODO_MAX_STEPS,
  AGENT_TODO_STEP_NOTE_MAX,
  AgentTodoStepStatusSchema,
  AgentTodoTemplateRecordSchema,
  AgentTodoTemplateProposalInputSchema,
  AgentTodoTemplateStepInputSchema,
  AgentTodoTemplateStepKeySchema,
  APPROVAL_ACTIONS,
} from '@nessie/schemas'
import {
  createAgentTodoTemplate,
  createApprovalRequestOnce,
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
  const { approval, approvers } = await createApprovalRequestOnce(context.prisma, {
    action: APPROVAL_ACTIONS.agentTodoTemplatePublish,
    actorContext: context.actorContext,
    channelId: context.channel.id,
    expiresInMs: AGENT_TODO_APPROVAL_EXPIRY_MS,
    // Equivalent proposals have no stable dedupe key — an agent naming the
    // same template twice is two genuinely new drafts — so `matches` never
    // fires and the per-requester ceiling, counted under the same lock, is
    // the control that stops the pile-up. That is why the lock keys on the
    // requester alone.
    lockKey: `todo-template-propose:${organizationId}:${context.agentId}`,
    matches: () => false,
    // The draft template is created inside the approval's locked transaction:
    // a refused or deduplicated ask must not leave a draft behind, and the
    // approval's context names the template it approves.
    prepare: async (tx) => {
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
      return { context: { templateId: template.id, version: template.version } }
    },
    reason: `Agent-proposed to-do template: ${args.name}`,
    // Approval visibility can include a member. The required role is what
    // mirrors the owner-only direct template-authoring route.
    requiredApproverRole: 'owner',
    requester: { agentId: context.agentId },
    runId: context.run.id,
  })
  // The creator already rang the owners (they answer this, so they are told —
  // without the bell a proposal sat behind the Approvals badge until somebody
  // happened to look, and expired if nobody did). The badge is gone with the
  // page behind it, so the card is now the whole surface: in this room for an
  // owner who is in it, and in the assistant conversation of every owner who
  // is not.
  await openApprovalCard(context, {
    agentId: context.agentId,
    approverUserIds: approvers,
    content: `I have drafted a to-do template, **${args.name}**, and it needs an owner's approval before it can be used.`,
    gate: {
      action: APPROVAL_ACTIONS.agentTodoTemplatePublish,
      approvalId: approval.id,
      status: 'pending',
    },
    organizationId,
    originChannelId: context.channel.id,
    originSystemChannelType: context.channel.systemChannelType ?? null,
    originThreadId: context.run.threadId,
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
