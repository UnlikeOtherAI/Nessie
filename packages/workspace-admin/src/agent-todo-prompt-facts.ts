import type { Prisma, PrismaClient } from '@prisma/client'
import {
  AGENT_TODO_PROMPT_INSTANCE_LIMIT,
  AGENT_TODO_PROMPT_TEMPLATE_LIMIT,
  type AgentTodoStatus,
  type AgentTodoStepStatus,
} from '@nessie/schemas'

type PrismaLike = PrismaClient | Prisma.TransactionClient

const TERMINAL_STEP_STATUSES = new Set<AgentTodoStepStatus>([
  'completed',
  'failed',
  'skipped',
])
const OPEN_INSTANCE_STATUSES: AgentTodoStatus[] = ['open', 'running']

export type AgentTodoPromptFacts = {
  activeTemplateCount: number
  activeTemplates: Array<{ id: string; name: string }>
  openInstanceCount: number
  openInstances: Array<{
    completedStepCount: number
    id: string
    stepCount: number
    title: string
  }>
  proposalDraftCount: number
  proposalDrafts: Array<{ id: string; name: string; status: 'pending' | 'rejected' }>
}

/**
 * Bounded, structural to-do facts for a run prompt. This reads no messages and
 * deliberately does not interpret a request; the model decides whether a
 * checklist applies once it sees the durable facts.
 */
export const loadAgentTodoPromptFacts = async (
  prisma: PrismaLike,
  input: { agentId: string; organizationId: string },
): Promise<AgentTodoPromptFacts> => {
  const templateWhere = {
    agentId: input.agentId,
    organizationId: input.organizationId,
    status: 'active' as const,
  }
  const instanceWhere = {
    agentId: input.agentId,
    organizationId: input.organizationId,
    status: { in: OPEN_INSTANCE_STATUSES },
  }
  const [
    activeTemplates,
    activeTemplateCount,
    openInstances,
    openInstanceCount,
  ] = await Promise.all([
    prisma.agentTodoTemplate.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true, name: true },
      take: AGENT_TODO_PROMPT_TEMPLATE_LIMIT,
      where: templateWhere,
    }),
    prisma.agentTodoTemplate.count({ where: templateWhere }),
    prisma.agentTodo.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true, steps: { select: { status: true } }, title: true },
      take: AGENT_TODO_PROMPT_INSTANCE_LIMIT,
      where: instanceWhere,
    }),
    prisma.agentTodo.count({ where: instanceWhere }),
  ])

  return {
    activeTemplateCount,
    activeTemplates,
    openInstanceCount,
    openInstances: openInstances.map((todo) => ({
      completedStepCount: todo.steps.filter((step) => TERMINAL_STEP_STATUSES.has(step.status))
        .length,
      id: todo.id,
      stepCount: todo.steps.length,
      title: todo.title,
    })),
    // Chunk 3 owns both proposal creation and the approval state that makes a
    // draft pending or rejected. Until then, expose no proposal facts rather
    // than fabricating an approval state from an ordinary draft row.
    proposalDraftCount: 0,
    proposalDrafts: [],
  }
}
