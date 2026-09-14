import {
  parseAgentId,
  parseRunId,
  type RunCompletionFollowupJobPayload,
} from '@nessie/schemas'
import { LedgerAttributionError } from '@nessie/runtime'

import { enqueueRunMemoryConsolidation } from '../memory-consolidation.js'
import { createMessageMentionAlerts } from '../mention-alerts.js'
import { markDelegationStepFinished, markRunPlanFinished } from '../plans.js'
import { drainPendingThreadMessagesBestEffort } from '../thread-serialization.js'
import { cleanupTerminalRun } from './terminal-cleanup.js'
import { loadRunContext } from './lifecycle.js'
import { maybeContinueParentWorkflow } from './parent-workflow.js'
import {
  publishAgentStatus,
  publishMessageCreated,
  publishMessageUpdated,
  publishRunUpdated,
  publishTaskUpdated,
} from './realtime.js'
import { enqueueInteractiveReplyPush } from './reply-push.js'
import { buildScopes } from './scopes.js'
import type { ExecutionDependencies } from './types.js'

const eventKey = (
  payload: RunCompletionFollowupJobPayload,
  organizationId: string,
  channelId: string,
  suffix: string,
): string => [
  'run-completion',
  organizationId,
  channelId,
  payload.source.threadId,
  payload.source.runId,
  suffix,
].join(':')

/** Replayable work whose durable intent committed with the successful answer. */
export const executeRunCompletionFollowup = async (
  deps: ExecutionDependencies,
  payload: RunCompletionFollowupJobPayload,
): Promise<void> => {
  const context = await loadRunContext(deps.prisma, payload.source)
  if (!context) {
    throw new Error(`completed run ${payload.source.runId} has no execution context`)
  }
  if (payload.delivery.kind === 'message' && payload.delivery.reply) {
    context.replyRootMessageId = payload.delivery.reply.rootMessageId
  }

  const key = (suffix: string): string => eventKey(
    payload,
    context.channel.organizationId,
    context.channel.id,
    suffix,
  )
  const { delivery } = payload

  if (delivery.kind === 'reaction') {
    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
      agentId: parseAgentId(context.agent.id),
      runId: parseRunId(context.run.id),
    }, { idempotencyKey: key('stream-done') })
  } else if (delivery.kind === 'watch') {
    await publishMessageUpdated(deps.realtimeTransport, context, {
      content: delivery.content,
      editedAt: new Date(delivery.editedAt),
      messageId: delivery.messageId,
      ...(delivery.restricted ? { restricted: true } : {}),
    }, { idempotencyKey: key('message-updated'), timestamp: payload.completedAt })
    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
      agentId: parseAgentId(context.agent.id),
      content: delivery.restricted ? '' : delivery.content,
      messageId: delivery.messageId,
      runId: parseRunId(context.run.id),
      ...(delivery.restricted ? { restricted: true } : {}),
    }, { idempotencyKey: key('stream-done') })
  } else {
    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
      agentId: parseAgentId(context.agent.id),
      content: delivery.restricted ? '' : delivery.content,
      createdAt: delivery.createdAt,
      messageId: delivery.messageId,
      runId: parseRunId(context.run.id),
      ...(delivery.restricted ? { restricted: true } : {}),
      ...(delivery.reply ? { rootMessageId: delivery.reply.rootMessageId } : {}),
    }, { idempotencyKey: key('stream-done') })
    await publishMessageCreated(deps.realtimeTransport, context, {
      authoredByOwner: delivery.authoredByOwner,
      content: delivery.content,
      messageId: delivery.messageId,
      role: delivery.role,
      ...(delivery.restricted ? { restricted: true } : {}),
      ...(delivery.reply
        ? {
            reply: {
              meta: {
                lastReplyAt: delivery.reply.lastReplyAt
                  ? new Date(delivery.reply.lastReplyAt)
                  : null,
                replyCount: delivery.reply.replyCount,
                replyParticipantIds: delivery.reply.replyParticipantIds,
              },
              rootMessageId: delivery.reply.rootMessageId,
            },
          }
        : {}),
    }, { idempotencyKey: key('message-created'), timestamp: payload.completedAt })

    if (!delivery.restricted) {
      await createMessageMentionAlerts(
        { prisma: deps.prisma, realtimeTransport: deps.realtimeTransport },
        {
          organizationId: context.channel.organizationId,
          channelId: context.channel.id,
          threadId: context.run.threadId,
          messageId: delivery.messageId,
          messageCreatedAt: new Date(delivery.createdAt),
          content: delivery.content,
          actorUserId: delivery.authoredByOwner
            ? payload.source.actorContext.actionContext.effectiveUserId
              ?? (payload.source.actorContext.actor.actorType === 'user'
                ? payload.source.actorContext.actor.actorId
                : null)
            : null,
          actorAgentId: context.agent.id,
          durableEventKey: key('mention-alert'),
          scopes: buildScopes(context),
        },
      )
    }
  }

  await cleanupTerminalRun(deps.prisma, context.run.id, deps.realtimeTransport, {
    mode: 'required',
  })

  try {
    await enqueueRunMemoryConsolidation(deps.prisma, payload.source)
  } catch (error) {
    // A run without the user/team attribution memory capture requires can
    // never become eligible on replay. Queue/storage failures are transient:
    // let them redeliver this already-durable completion follow-up.
    if (!(error instanceof LedgerAttributionError)) {
      throw error
    }
    console.warn('[worker.memory] skipped run memory consolidation without attribution', {
      error,
      runId: context.run.id,
    })
  }
  await markRunPlanFinished(deps.prisma, {
    artifacts: { iterations: payload.iterations, toolCallsUsed: payload.toolCallsUsed },
    planId: payload.planId,
    rootStepId: payload.rootStepId,
    success: true,
    summary: payload.responseText.slice(0, 500),
  })
  await markDelegationStepFinished(deps.prisma, {
    artifacts: {
      iterations: payload.iterations,
      responseText: payload.responseText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    planId: payload.source.parentPlanId,
    planStepId: payload.source.parentPlanStepId,
    success: true,
  })
  await maybeContinueParentWorkflow(deps, payload.source, {
    output: {
      responseText: payload.responseText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    success: true,
  })

  await publishRunUpdated(
    deps.realtimeTransport,
    context,
    'completed',
    { idempotencyKey: key('run-updated'), timestamp: payload.completedAt },
  )
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'done',
    { idempotencyKey: key('task-updated'), timestamp: payload.completedAt },
  )
  const newerActiveRun = await deps.prisma.run.findFirst({
    select: { id: true },
    where: {
      agentId: context.agent.id,
      createdAt: { gt: context.run.createdAt },
      id: { not: context.run.id },
      status: { in: ['pending', 'running', 'waiting_approval', 'waiting_input'] },
    },
  })
  if (!newerActiveRun) {
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      since: payload.completedAt,
      status: 'idle',
    }, { idempotencyKey: key('agent-idle'), timestamp: payload.completedAt })
  }

  await drainPendingThreadMessagesBestEffort(deps.prisma, {
    agentId: context.agent.id,
    ...(context.run.principalUserId ? { principalUserId: context.run.principalUserId } : {}),
    threadId: context.run.threadId,
  })
  if (delivery.kind === 'message') {
    await enqueueInteractiveReplyPush(deps, payload.source, context, {
      content: delivery.content,
      contentVisibility: delivery.restricted ? 'generic' : 'full',
      id: delivery.messageId,
    }, { required: true })
  } else if (delivery.kind === 'reaction') {
    await enqueueInteractiveReplyPush(deps, payload.source, context, {
      content: 'An agent reacted to your message.',
      contentVisibility: 'full',
      id: delivery.sourceMessageId,
    }, { required: true })
  }
}
