import { Prisma } from '@prisma/client'
import { claimMessageEmbeddingInTransaction, enqueueQueueJob } from '@nessie/db'
import {
  RUN_COMPLETION_FOLLOWUP_TOPIC,
  type RunCompletionFollowupJobPayload,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'

import { persistInvocationLedgerEvents } from '../inference.js'
import { createAgentMessage } from './agent-message.js'
import { recordTicketWorkRunSpend } from './ticket-work-setup.js'
import { commitSuccessfulRun } from './completion-commit.js'
import { applyRunReplyBookkeeping } from './lifecycle.js'
import { noteSubscriptionSuccess } from './subscription-health.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext, RunPlanContext } from './types.js'
import { foldWatchStatus } from './watch-status.js'
import { DONE_REACTION } from './one-on-one-plan.js'
import { setAgentReaction } from './working-marker.js'

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
    /** One-on-one work finished with nothing worth reading: mark the message done. */
    markedDone?: boolean
    toolCallsUsed: number
  },
): Promise<void> => {
  await persistInvocationLedgerEvents(deps.prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    runId: context.run.id,
    invocations: input.invocations,
  })
  await recordTicketWorkRunSpend(deps.prisma, { actorContext: payload.actorContext, runId: context.run.id })

  // A successful run on a personal subscription clears any transient health
  // problem and records that the credential was actually used.
  await noteSubscriptionSuccess(deps, context)

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
      } else if (input.markedDone) {
        // The request is done and needs no written reply: the person's message
        // is marked the way the agent's own reaction would mark it, in the same
        // commit as the run's success.
        await setAgentReaction(tx, {
          agentId: context.agent.id,
          emoji: DONE_REACTION,
          messageId: payload.messageId,
          ...(context.run.principalUserId ? { onBehalfOfUserId: context.run.principalUserId } : {}),
        })
        delivery = { emoji: DONE_REACTION, kind: 'reaction', sourceMessageId: payload.messageId }
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
      } else if (input.responseText.trim().length === 0) {
        // Nothing was said, so nothing is posted. An agent that answers with a
        // card has already put its whole turn in the conversation, and an empty
        // bubble behind it is the second message this exists to remove. The
        // test is emptiness and nothing else — a bare "👍" is a real message
        // and is only ever suppressed by the reaction branch above, which knows
        // the run actually reacted.
        delivery = { kind: 'silent' }
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
        // Jev placed this answer in the main chat with a link back to the
        // earlier message it is about; the admin draws that link.
        const earlier = context.oneOnOnePlan?.earlier
        const extraMetadata = {
          ...(input.messageMetadata ?? {}),
          ...(activeTodo ? { todoRef: { todoId: activeTodo.id } } : {}),
          ...(earlier?.reference === 'link' ? { messageRef: { messageId: earlier.messageId } } : {}),
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
        // The reply is indexed as the person it answered, while this run still
        // holds their session identity; the embed job that follows has none.
        const requesterId = payload.actorContext.actionContext.effectiveUserId
          ?? (payload.actorContext.actor.actorType === 'user'
            ? payload.actorContext.actor.actorId
            : null)
        const requesterIdentity = payload.actorContext.actionContext.uoaIdentity
        if (requesterId && requesterIdentity) {
          await claimMessageEmbeddingInTransaction(tx, {
            content: assistantMessage.content,
            embeddingModel: deps.modelClient.embeddingModel,
            id: assistantMessage.id,
            organizationId: context.channel.organizationId,
            origin: { userId: requesterId, uoaIdentity: requesterIdentity },
          })
        }
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
