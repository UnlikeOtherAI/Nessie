import type { Prisma } from '@prisma/client'
import { parseAgentId, parseRunId, type RunExecuteJobPayload } from '@nessie/schemas'
import { markDelegationStepFinished, markRunPlanFinished } from '../plans.js'
import { buildScopes } from './scopes.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus, applyRunReplyBookkeeping } from './lifecycle.js'
import { maybeContinueParentWorkflow } from './parent-workflow.js'
import { publishAgentStatus, publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import { drainPendingThreadMessagesBestEffort } from '../thread-serialization.js'
import { classifyError, userMessageForFailureReason } from '../error-classification.js'
import { isInteractiveRun } from './continuation.js'

/** Control-flow marker: this run has nobody waiting, so it posts nothing. */
class SkipTerminalMessage extends Error {}
import type { ExecutionDependencies, RunContext, RunPlanContext } from './types.js'
import { createAgentMessage } from './agent-message.js'
import { enqueueInteractiveReplyPush } from './reply-push.js'

export const handleRunExecutionFailure = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    error: unknown
    planContext: RunPlanContext | null
    streamStarted: boolean
    // Overrides the default "I hit an error…" reply for terminal outcomes that
    // are not crashes — e.g. a budget-cap stop that produced no partial answer,
    // which posts a clear "stopped at the limit" notice instead.
    terminalMessage?: string
    /** Metadata for that terminal message — `runStop` (§6) for a capped run. */
    terminalMessageMetadata?: Record<string, unknown>
  },
): Promise<void> => {
  const messageText =
    input.error instanceof Error ? input.error.message : 'Run execution failed unexpectedly'
  const failureReason = classifyError(input.error)

  const fallbackMessageId = `run-error:${context.run.id}`
  let terminalMessageId = fallbackMessageId
  let terminalContent =
    input.terminalMessage ?? userMessageForFailureReason(failureReason)
  let terminalCreatedAt = new Date().toISOString()
  let replyPushMessage: {
    content: string
    contentVisibility: 'full' | 'generic'
    id: string
  } | null = null

  // Only tell somebody who is waiting.
  //
  // An interactive turn has a person on the other end who must not be left
  // hanging, so every terminal path posts. An unattended run — a schedule, an
  // interval, a webhook fire — has nobody waiting, and posting there turns a
  // broken integration into a repeating apology: a 15-minute sweep that cannot
  // reach its provider wrote the same "I could not complete that request" into
  // its own alert channel four times an hour, burying the findings it existed
  // to deliver. The failure is not hidden — the run is `failed`, the Triggers
  // page delivery row now shows that outcome, and the error is logged — it
  // simply stops being announced to a room that did not ask.
  const announceFailure = isInteractiveRun(payload) && failureReason !== 'private_agent_placement'

  try {
    if (!announceFailure) throw new SkipTerminalMessage()
    const errorMessage = await createAgentMessage(deps.prisma, context, {
      agentId: context.agent.id,
      content: terminalContent,
      role: 'assistant',
      threadId: context.run.threadId,
      ...(input.terminalMessageMetadata
        ? { metadata: input.terminalMessageMetadata as Prisma.InputJsonValue }
        : {}),
      ...(context.replyRootMessageId
        ? { rootMessageId: context.replyRootMessageId }
        : {}),
    })

    terminalMessageId = errorMessage.id
    terminalCreatedAt = errorMessage.createdAt.toISOString()

    const reply = await applyRunReplyBookkeeping(
      deps.prisma,
      context,
      errorMessage.createdAt,
    )

    await publishMessageCreated(deps.realtimeTransport, context, {
      content: errorMessage.content,
      messageId: errorMessage.id,
      role: errorMessage.role,
      ...(reply ? { reply } : {}),
    })
    replyPushMessage = {
      content: errorMessage.content,
      contentVisibility: errorMessage.basis.length > 0 ? 'generic' : 'full',
      id: errorMessage.id,
    }
  } catch (streamError) {
    if (streamError instanceof SkipTerminalMessage) {
      console.warn(
        `[worker] run ${context.run.id} failed without a channel message: ${messageText}`,
      )
    } else {
      console.error('Failed to persist terminal error message', streamError)
    }
  }

  if (input.streamStarted) {
    try {
      await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
        agentId: parseAgentId(context.agent.id),
        content: terminalContent,
        createdAt: terminalCreatedAt,
        messageId: terminalMessageId,
        ...(context.replyRootMessageId
          ? { rootMessageId: context.replyRootMessageId }
          : {}),
        runId: parseRunId(context.run.id),
      })
    } catch (streamError) {
      console.error('Failed to publish terminal stream event', streamError)
    }
  }

  await updateRunStatus(deps.prisma, context.run.id, 'failed')
  await updateTaskStatus(deps.prisma, context.task.id, 'failed')
  if (input.planContext) {
    await markRunPlanFinished(deps.prisma, {
      artifacts: {
        error: messageText,
      },
      planId: input.planContext.planId,
      rootStepId: input.planContext.rootStepId,
      success: false,
      summary: messageText.slice(0, 500),
    })
  }
  await markDelegationStepFinished(deps.prisma, {
    artifacts: {
      error: messageText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    planId: payload.parentPlanId,
    planStepId: payload.parentPlanStepId,
    success: false,
    summary: messageText.slice(0, 500),
  })
  await maybeContinueParentWorkflow(deps, payload, {
    output: {
      error: messageText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    success: false,
    summary: messageText.slice(0, 500),
  })
  await setAgentStatus(deps.prisma, context.agent.id, 'error')
  await publishRunUpdated(deps.realtimeTransport, context, 'failed')
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'failed',
  )
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: 'error',
  })

  await deps.prisma.taskEvent.create({
    data: {
      eventType: 'run.failed',
      payload: {
        message: messageText,
      },
      taskId: context.task.id,
    },
  })

  // The failed run releases the (agent, thread) slot: pended messages are
  // delivered as one batched follow-up run (see thread-serialization.ts).
  await drainPendingThreadMessagesBestEffort(deps.prisma, {
    agentId: context.agent.id,
    threadId: context.run.threadId,
  })
  if (replyPushMessage) {
    await enqueueInteractiveReplyPush(deps, payload, context, replyPushMessage)
  }
}
