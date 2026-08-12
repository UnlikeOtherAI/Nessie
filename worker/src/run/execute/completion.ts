import { Prisma } from '@prisma/client'
import { markRecallsReferenced } from '@nessie/memory'
import { parseAgentId, parseRunId } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'
import { persistInvocationLedgerEvents } from '../inference.js'
import { enqueueRunMemoryConsolidation } from '../memory-consolidation.js'
import { markDelegationStepFinished, markRunPlanFinished } from '../plans.js'
import { createMessageMentionAlerts } from '../mention-alerts.js'
import { createAgentMessage } from './agent-message.js'
import { buildScopes } from './scopes.js'
import { foldWatchStatus } from './watch-status.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus, applyRunReplyBookkeeping } from './lifecycle.js'
import { detectReferencedRecallIds } from './memory.js'
import { maybeContinueParentWorkflow } from './parent-workflow.js'
import {
  publishAgentStatus,
  publishMessageCreated,
  publishMessageUpdated,
  publishRunUpdated,
  publishTaskUpdated,
} from './realtime.js'
import { drainPendingThreadMessagesBestEffort } from '../thread-serialization.js'
import type { ExecutionDependencies, RetrievedMemory, RunContext, RunPlanContext } from './types.js'
import type { RunExecuteJobPayload } from '@nessie/schemas'

export const completeRunExecution = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  planContext: RunPlanContext,
  input: {
    invocations: InvocationRecord[]
    iterations: number
    memories: RetrievedMemory[]
    /**
     * Extra metadata for the terminal message — currently `runStop` (§6), which
     * is what admin renders its Continue affordance from.
     */
    messageMetadata?: Record<string, unknown>
    responseText: string
    /**
     * Set for a recurring watch whose sweep found nothing new: this text
     * becomes the watch's rolling status line instead of a new message.
     * Decided by the model (`watch-status.ts`), never by reading the prose.
     */
    rollingWatch?: { triggerId: string }
    /**
     * The run already answered with a reaction and its leftover text carries
     * no information, so there is nothing left to post.
     */
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

  if (input.reactionWasTheAnswer) {
    // Nothing to write: the reaction is on the message the run answered. Still
    // terminate the stream so the thinking bubble clears.
    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
      agentId: parseAgentId(context.agent.id),
      runId: parseRunId(context.run.id),
    })
  } else if (input.rollingWatch) {
    const fold = await foldWatchStatus(deps.prisma, {
      agentId: context.agent.id,
      content: input.responseText,
      lastRunId: context.run.id,
      now: new Date(),
      threadId: context.run.threadId,
      triggerId: input.rollingWatch.triggerId,
    })
    // An edit adds no row, so unread counts do not move and no mention alert
    // fires — which is the point: a quiet sweep must not light the channel up.
    await publishMessageUpdated(deps.realtimeTransport, context, {
      content: input.responseText,
      editedAt: fold.editedAt,
      messageId: fold.messageId,
    })
    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
      agentId: parseAgentId(context.agent.id),
      content: input.responseText,
      messageId: fold.messageId,
      runId: parseRunId(context.run.id),
    })
  } else {
  // The personal assistant is its owner's delegate: anything it posts into a
  // shared channel is authored as that owner (mirroring the immediate
  // send_message tool), not as the assistant bot. Replies inside its own DM
  // stay assistant-authored so the DM still renders the assistant.
  const delegatedOwnerId =
    context.agent.agentKind === 'personal_assistant'
    && context.channel.systemChannelType !== 'personal_assistant'
      ? payload.actorContext.actionContext.effectiveUserId
        ?? (payload.actorContext.actor.actorType === 'user'
          ? payload.actorContext.actor.actorId
          : null)
      : null

  // Reply-thread placement (#233): the normal assistant reply attaches to the
  // run's reply-thread root; a PA delegating into a shared channel stays
  // top-level (it is authored as the owner, not as the assistant).
  const rootMessageId = delegatedOwnerId ? undefined : context.replyRootMessageId

  const extraMetadata = input.messageMetadata ?? {}
  // Both branches go through the one stamping chokepoint. The delegated-PA
  // branch matters especially: it authors agent-generated content as
  // `role: 'user'`, so a predicate keyed on agent authorship alone would miss
  // it — `delegatedByAgentId` in metadata is what marks it structurally.
  const assistantMessage = await createAgentMessage(deps.prisma, context, delegatedOwnerId
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
        ...(input.messageMetadata
          ? { metadata: extraMetadata as Prisma.InputJsonValue }
          : {}),
        ...(rootMessageId ? { rootMessageId } : {}),
      })

  const reply = rootMessageId
    ? await applyRunReplyBookkeeping(deps.prisma, context, assistantMessage.createdAt)
    : undefined

  // The thread SSE connection registers with a thread id and no viewer, so it
  // cannot be filtered per-recipient. A restricted reply therefore closes the
  // stream without its content; entitled readers refetch through the gated list.
  const restricted = assistantMessage.basis.length > 0

  await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
    agentId: parseAgentId(context.agent.id),
    content: restricted ? '' : input.responseText,
    createdAt: assistantMessage.createdAt.toISOString(),
    messageId: assistantMessage.id,
    runId: parseRunId(context.run.id),
    ...(restricted ? { restricted: true } : {}),
    ...(rootMessageId ? { rootMessageId } : {}),
  })

  await publishMessageCreated(deps.realtimeTransport, context, {
    authoredByOwner: delegatedOwnerId !== null,
    content: input.responseText,
    messageId: assistantMessage.id,
    role: delegatedOwnerId ? 'user' : 'assistant',
    ...(restricted ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })

  // Agent-authored @mentions create the same durable alerts as human ones —
  // except for a restricted reply. An alert is a durable row plus a push
  // notification carrying the mention's framing, so alerting someone who cannot
  // read the message hands them both its existence and a doorway to it. The
  // reply still exists for anyone entitled; it simply does not go looking for
  // readers who are not.
  if (!restricted) {
    await createMessageMentionAlerts(
      { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
      {
        organizationId: context.channel.organizationId,
        channelId: context.channel.id,
        threadId: context.run.threadId,
        messageId: assistantMessage.id,
        messageCreatedAt: assistantMessage.createdAt,
        content: input.responseText,
        actorUserId: delegatedOwnerId,
        actorAgentId: context.agent.id,
        scopes: buildScopes(context),
      },
    )
  }

  }

  await updateRunStatus(deps.prisma, context.run.id, 'completed', deps.realtimeTransport)
  await updateTaskStatus(deps.prisma, context.task.id, 'done')
  // Memory consolidation is best-effort: a failure to enqueue it must never
  // turn an already-completed run into a failed one (the outer catch would).
  try {
    await enqueueRunMemoryConsolidation(deps.prisma, payload)
  } catch (consolidationError) {
    console.error(
      '[worker.memory] failed to enqueue run memory consolidation for run',
      context.run.id,
      consolidationError,
    )
  }
  await markRunPlanFinished(deps.prisma, {
    artifacts: {
      iterations: input.iterations,
      toolCallsUsed: input.toolCallsUsed,
    },
    planId: planContext.planId,
    rootStepId: planContext.rootStepId,
    success: true,
    summary: input.responseText.slice(0, 500),
  })
  await markDelegationStepFinished(deps.prisma, {
    artifacts: {
      responseText: input.responseText,
      runId: context.run.id,
      taskId: context.task.id,
      iterations: input.iterations,
    },
    planId: payload.parentPlanId,
    planStepId: payload.parentPlanStepId,
    success: true,
  })
  await maybeContinueParentWorkflow(deps, payload, {
    output: {
      responseText: input.responseText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    success: true,
  })
  await setAgentStatus(deps.prisma, context.agent.id, 'idle')
  await publishRunUpdated(deps.realtimeTransport, context, 'completed')
  await publishTaskUpdated(deps.realtimeTransport, buildScopes(context), context.task.id, 'done')
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: 'idle',
  })
  // The run slot is free: deliver any messages that pended while this run was
  // in flight as one batched follow-up run (see thread-serialization.ts).
  await drainPendingThreadMessagesBestEffort(deps.prisma, {
    agentId: context.agent.id,
    threadId: context.run.threadId,
  })
}
