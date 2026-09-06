import type { Prisma, PrismaClient } from '@prisma/client'
import {
  AgentTodoScheduledConfigError,
  buildScheduledAgentTodoKickoff,
  claimAgentTodoForRun,
  materializeScheduledAgentTodosForRun,
  readAgentTodoKickoff,
  readAgentTodoScheduledKickoff,
} from '@nessie/team-admin'

import { recordTriggerHealthFailure } from '../../control/trigger-health.js'
import type { RunContext } from './types.js'

/**
 * Turn an agent-todo kickoff on the trigger message into this run's prompt.
 *
 * Two shapes reach here and they are deliberately different. A "Run now" on one
 * checklist item only *identifies* the instance while it is pending, so the
 * claim happens inside the executing run — a queued cancel then cannot strand a
 * checklist under a run that never started. A scheduled kickoff instead
 * materialises this occurrence's items and rewrites the prompt from them plus
 * whatever is still open from earlier occurrences, so the model sees the
 * backlog rather than only today's list.
 *
 * Returns the prompt to run with — the caller's own when neither kickoff is
 * present. The rewritten prompt is persisted onto the trigger message so the
 * thread, a restart and a continuation all read the same words.
 */
export const resolveAgentTodoKickoffPrompt = async (
  prisma: PrismaClient,
  context: RunContext,
  input: { messageId: string; metadata: Prisma.JsonValue | null; prompt: string },
): Promise<string> => {
  const todoKickoff = readAgentTodoKickoff(input.metadata)
  if (todoKickoff) {
    await claimAgentTodoForRun(prisma, {
      agentId: context.agent.id,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
      threadId: context.run.threadId,
      todoId: todoKickoff.todoId,
    })
  }

  const scheduledTodoKickoff = readAgentTodoScheduledKickoff(input.metadata)
  if (!scheduledTodoKickoff) return input.prompt

  try {
    const todos = await materializeScheduledAgentTodosForRun(prisma, {
      agentId: context.agent.id,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
      threadId: context.run.threadId,
      templateRefs: scheduledTodoKickoff.todoTemplates,
    })
    const historic = await prisma.agentTodo.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { createdAt: true, id: true, title: true },
      where: {
        agentId: context.agent.id,
        id: { notIn: todos.map((todo) => todo.id) },
        organizationId: context.channel.organizationId,
        status: { in: ['open', 'running'] },
        templateId: { in: scheduledTodoKickoff.todoTemplateIds },
      },
    })
    const prompt = buildScheduledAgentTodoKickoff(
      todos,
      historic.map((todo) => ({
        age: `${Math.floor((Date.now() - todo.createdAt.getTime()) / 86_400_000)}d`,
        id: todo.id,
        title: todo.title,
      })),
    )
    await prisma.message.update({
      where: { id: input.messageId },
      data: { content: prompt },
    })
    return prompt
  } catch (error) {
    if (error instanceof AgentTodoScheduledConfigError) {
      await recordTriggerHealthFailure(prisma, {
        error,
        triggerId: error.triggerId,
      })
    }
    throw error
  }
}
