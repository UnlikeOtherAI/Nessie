import type { Prisma, PrismaClient } from '@prisma/client'
import {
  AgentTodoKickoffMetadataSchema,
  AgentTodoScheduledKickoffMetadataSchema,
  type AgentTodoScheduledTemplateRef,
} from '@nessie/schemas'
import { z } from 'zod'

type PrismaLike = PrismaClient | Prisma.TransactionClient

type MaterializedTodo = {
  id: string
  steps: ReadonlyArray<{ instructions: string; key: string; title: string }>
  title: string
}

/**
 * The kickoff is built from the instance rows, never from its template. A
 * template may change after this instance was created; the run must always
 * receive the exact version its progress card shows.
 */
export const buildAgentTodoKickoff = (todo: MaterializedTodo): string => [
  `Work through the to-do ${JSON.stringify(todo.title)} in order.`,
  'These are the materialized checklist steps for this instance:',
  ...todo.steps.map(
    (step, index) => `${index + 1}. [${step.key}] ${step.title}: ${step.instructions}`,
  ),
  'Record each structural change with todo_step_update before continuing.',
].join('\n')

export const agentTodoKickoffMetadata = (todoId: string) => ({
  todoKickoff: AgentTodoKickoffMetadataSchema.parse({ todoId }),
})

export const agentTodoScheduledKickoffMetadata = (
  templateRefs: readonly AgentTodoScheduledTemplateRef[],
) => ({
  todoScheduledKickoff: AgentTodoScheduledKickoffMetadataSchema.parse({
    todoTemplates: [...new Map(
      templateRefs.map((template) => [template.templateId, template]),
    ).values()],
  }),
})

export const readAgentTodoKickoff = (metadata: unknown): { todoId: string } | null => {
  const parsed = z.object({
    todoKickoff: AgentTodoKickoffMetadataSchema,
  }).safeParse(metadata)
  return parsed.success ? parsed.data.todoKickoff : null
}

export const readAgentTodoScheduledKickoff = (
  metadata: unknown,
): {
  todoTemplateIds: string[]
  todoTemplates: AgentTodoScheduledTemplateRef[]
} | null => {
  const parsed = z.object({
    todoScheduledKickoff: AgentTodoScheduledKickoffMetadataSchema,
  }).safeParse(metadata)
  return parsed.success
    ? {
        todoTemplateIds: parsed.data.todoScheduledKickoff.todoTemplates.map(
          (template) => template.templateId,
        ),
        todoTemplates: parsed.data.todoScheduledKickoff.todoTemplates,
      }
    : null
}

/**
 * A scheduled run is an honest record of every distinct checklist it adopted.
 * Existing open instances are facts for the model to decide about; there is no
 * rollover, cancellation, or automatic adoption of that older work.
 */
export const buildScheduledAgentTodoKickoff = (
  todos: readonly MaterializedTodo[],
  openInstances: readonly { age: string; id: string; title: string }[],
): string => [
  ...todos.flatMap((todo) => buildAgentTodoKickoff(todo).split('\n')),
  ...(openInstances.length > 0
    ? [
        'Existing unfinished instances of these templates are facts only; decide whether one needs attention first:',
        ...openInstances.map((todo) => `- todoId=${todo.id} | title=${JSON.stringify(todo.title)} | age=${todo.age}`),
      ]
    : []),
].join('\n')

/**
 * Clear a completed/failed/cancelled run's ownership promptly. Readers still
 * join the Run status before treating an activeRunId as live, because API-side
 * terminal transitions and a process crash can leave this cleanup behind.
 */
export const releaseAgentTodosForTerminalRun = async (
  prisma: PrismaLike,
  runId: string,
): Promise<void> => {
  await prisma.agentTodo.updateMany({
    data: { activeRunId: null, status: 'open' },
    where: { activeRunId: runId, status: 'running' },
  })
  await prisma.agentTodo.updateMany({
    data: { activeRunId: null },
    where: { activeRunId: runId, status: { not: 'running' } },
  })
}
