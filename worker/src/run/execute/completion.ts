import { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import { markRecallsReferenced } from '@nessie/memory'
import {
  RUN_COMPLETION_FOLLOWUP_TOPIC,
  type RunCompletionFollowupJobPayload,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'

import { persistInvocationLedgerEvents } from '../inference.js'
import { createAgentMessage } from './agent-message.js'
import { commitSuccessfulRun } from './completion-commit.js'
import { applyRunReplyBookkeeping } from './lifecycle.js'
import { detectReferencedRecallIds } from './memory.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext, RunPlanContext } from './types.js'
import { foldWatchStatus } from './watch-status.js'

export const completeRunExecution = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  planContext: RunPlanContext,
  input: {
    invocations: InvocationRecord[]
    iterations: number
    memories: RetrievedMemory[]
    messageMetadata?: Record<string, unknown>
    responseText: string
    rollingWatch?: { triggerId: string }
    reactionWasTheAnswer?: boolean
    toolCallsUsed: number
  },
): Promise<void> => {
  await persistInvocationLedgerEvents(deps.prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    runId: context.run.id,
    invocations: input.invocations,
  })

  const referencedRecallIds = detectReferencedRecallIds(input.responseText, input.memories)
  if (referencedRecallIds.length > 0) {
    await markRecallsReferenced(referencedRecallIds, deps.searchConfig.pool)
  }

  const completedAt = new Date()
  await commitSuccessfulRun(
    deps.prisma,
    {
      agentId: context.agent.id,
      completedAt,
      runId: context.run.id,
      taskId: context.task.id,
    },
    async (tx) => {
      let delivery: RunCompletionFollowupJobPayload['delivery']

      if (input.reactionWasTheAnswer) {
        delivery = { kind: 'reaction', sourceMessageId: payload.messageId }
      } else if (input.rollingWatch) {
        const fold = await foldWatchStatus(tx, context, {
          agentId: context.agent.id,
          content: input.responseText,
          lastRunId: context.run.id,
          now: completedAt,
          threadId: context.run.threadId,
          triggerId: input.rollingWatch.triggerId,
        })
        delivery = {
          content: input.responseText,
          editedAt: fold.editedAt.toISOString(),
          kind: 'watch',
          messageId: fold.messageId,
          restricted: fold.restricted,
        }
      } else {
        const delegatedOwnerId =
          context.agent.agentKind === 'personal_assistant'
          && context.channel.systemChannelType !== 'personal_assistant'
            ? payload.actorContext.actionContext.effectiveUserId
              ?? (payload.actorContext.actor.actorType === 'user'
                ? payload.actorContext.actor.actorId
                : null)
            : null
        const rootMessageId = delegatedOwnerId ? undefined : context.replyRootMessageId
        const activeTodo = await tx.agentTodo.findFirst({
          select: { id: true },
          where: {
            activeRunId: context.run.id,
            activeRun: { is: { status: { notIn: ['completed', 'failed', 'cancelled'] } } },
          },
        })
        const extraMetadata = {
          ...(input.messageMetadata ?? {}),
          ...(activeTodo ? { todoRef: { todoId: activeTodo.id } } : {}),
        }
        const assistantMessage = await createAgentMessage(tx, context, delegatedOwnerId
          ? {
              content: input.responseText,
              metadata: {
                ...extraMetadata,
                delegatedByAgentId: context.agent.id,
                delegatedFromRunId: context.run.id,
              } as Prisma.InputJsonValue,
              role: 'user',
              threadId: context.run.threadId,
              userId: delegatedOwnerId,
            }
          : {
              agentId: context.agent.id,
              content: input.responseText,
              role: 'assistant',
              threadId: context.run.threadId,
              ...(Object.keys(extraMetadata).length > 0
                ? { metadata: extraMetadata as Prisma.InputJsonValue }
                : {}),
              ...(rootMessageId ? { rootMessageId } : {}),
            })
        const reply = rootMessageId
          ? await applyRunReplyBookkeeping(tx, context, assistantMessage.createdAt)
          : undefined

        delivery = {
          authoredByOwner: delegatedOwnerId !== null,
          content: assistantMessage.content,
          createdAt: assistantMessage.createdAt.toISOString(),
          kind: 'message',
          messageId: assistantMessage.id,
          restricted: assistantMessage.basis.length > 0,
          role: delegatedOwnerId ? 'user' : 'assistant',
          ...(reply
            ? {
                reply: {
                  lastReplyAt: reply.meta.lastReplyAt?.toISOString() ?? null,
                  replyCount: reply.meta.replyCount,
                  replyParticipantIds: reply.meta.replyParticipantIds,
                  rootMessageId: reply.rootMessageId,
                },
              }
            : {}),
        }
      }

      const followup = {
        completedAt: completedAt.toISOString(),
        delivery,
        iterations: input.iterations,
        planId: planContext.planId,
        responseText: input.responseText,
        rootStepId: planContext.rootStepId,
        source: payload,
        toolCallsUsed: input.toolCallsUsed,
      } satisfies RunCompletionFollowupJobPayload
      await enqueueQueueJob(tx, {
        idempotencyKey: `run-completion-followup:${context.run.id}`,
        maxAttempts: 10,
        payload: followup,
        topic: RUN_COMPLETION_FOLLOWUP_TOPIC,
      })
    },
  )
}
