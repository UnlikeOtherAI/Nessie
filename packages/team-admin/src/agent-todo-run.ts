import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AgentTodoRunResult,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import {
  agentTodoKickoffMetadata,
  buildAgentTodoKickoff,
} from './agent-todo-kickoff.js'
import { agentTodoWithOrderedSteps } from './agent-todo-records.js'
import { isTerminalAgentTodoRunStatus } from './agent-todo-run-statuses.js'
import { ensureDefaultThread } from './channel-records.js'

type PrismaLike = PrismaClient | Prisma.TransactionClient

export type AgentTodoRunQueue = {
  claimThreadRunOrPend: (
    tx: Prisma.TransactionClient,
    input: {
      agentId: string
      threadId: string
      pending: {
        actorContext: AuthorizedActionContext
        channelId: string
        interactive: boolean
        messageId: string
      }
    },
  ) => Promise<'claimed' | 'pended' | 'duplicate'>
  enqueueRunExecution: (
    prisma: Pick<PrismaClient, '$executeRaw'>,
    payload: RunExecuteJobPayload,
    idempotencyKey?: string,
  ) => Promise<boolean>
}

export type StartAgentTodoRunResult =
  | { kind: 'channel_not_found' }
  | { kind: 'agent_not_bound' }
  | { kind: 'todo_not_found' }
  | { kind: 'todo_unavailable' }
  | { kind: 'started'; result: AgentTodoRunResult }

/**
 * The one Run-now fire preparation seam. Trigger delivery extends this rather
 * than rebuilding a subtly different pending/claim/queue sequence in either
 * the API or worker process.
 */
export const startAgentTodoRun = async (
  prisma: PrismaLike,
  queue: AgentTodoRunQueue,
  input: {
    actorContext: AuthorizedActionContext
    agentId: string
    channelId: string
    organizationId: string
    todoId: string
  },
): Promise<StartAgentTodoRunResult> => {
  const execute = async (tx: Prisma.TransactionClient): Promise<StartAgentTodoRunResult> => {
    const membership = await tx.channelMember.findFirst({
      select: { id: true },
      where: {
        channelId: input.channelId,
        channel: { is: { organizationId: input.organizationId } },
        userId: input.actorContext.actor.actorId,
      },
    })
    if (!membership) return { kind: 'channel_not_found' }

    const binding = await tx.agentBinding.findFirst({
      select: { id: true },
      where: { agentId: input.agentId, channelId: input.channelId },
    })
    if (!binding) return { kind: 'agent_not_bound' }

    const todo = await tx.agentTodo.findFirst({
      include: agentTodoWithOrderedSteps,
      where: {
        agentId: input.agentId,
        id: input.todoId,
        organizationId: input.organizationId,
      },
    })
    if (!todo) return { kind: 'todo_not_found' }
    if (
      todo.status === 'cancelled'
      || todo.status === 'completed'
      || (todo.activeRunId !== null
        && todo.activeRun !== null
        && !isTerminalAgentTodoRunStatus(todo.activeRun.status))
    ) return { kind: 'todo_unavailable' }

    const threadId = await ensureDefaultThread(tx, input.channelId)
    const message = await tx.message.create({
      data: {
        content: buildAgentTodoKickoff(todo),
        metadata: agentTodoKickoffMetadata(todo.id),
        // The visible assistant reply carries `todoRef`; this internal
        // server-authored kickoff remains out of the channel feed.
        role: 'system',
        threadId,
      },
    })
    const claim = await queue.claimThreadRunOrPend(tx, {
      agentId: input.agentId,
      threadId,
      pending: {
        actorContext: input.actorContext,
        channelId: input.channelId,
        interactive: false,
        messageId: message.id,
      },
    })
    if (claim !== 'claimed') {
      return {
        kind: 'started',
        result: {
          channelId: parseChannelId(input.channelId),
          status: 'pended',
          threadId: parseThreadId(threadId),
        },
      }
    }

    const run = await tx.run.create({
      data: {
        agentId: input.agentId,
        replyPlacement: 'channel',
        status: 'pending',
        threadId,
        triggerMessageId: message.id,
      },
      select: { id: true },
    })
    const task = await tx.task.create({
      data: {
        agentId: input.agentId,
        organizationId: input.organizationId,
        purpose: todo.title,
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })
    await queue.enqueueRunExecution(tx, {
      actorContext: withActionContext(input.actorContext, {
        agentId: parseAgentId(input.agentId),
        channelId: parseChannelId(input.channelId),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(threadId),
      }),
      agentId: parseAgentId(input.agentId),
      interactive: false,
      messageId: message.id,
      runId: parseRunId(run.id),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(threadId),
    }, `run:${run.id}`)
    return {
      kind: 'started',
      result: {
        channelId: parseChannelId(input.channelId),
        runId: parseRunId(run.id),
        status: 'queued',
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(threadId),
      },
    }
  }
  return '$transaction' in prisma ? prisma.$transaction(execute) : execute(prisma)
}
