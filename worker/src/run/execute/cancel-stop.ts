import type { PrismaClient } from '@prisma/client'
import { parseAgentId, parseRunId, type RunExecuteJobPayload } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'
import { persistInvocationLedgerEvents } from '../inference.js'
import { markDelegationStepFinished, markRunPlanFinished } from '../plans.js'
import { maybeContinueParentWorkflow } from './parent-workflow.js'
import { buildScopes } from './scopes.js'
import { setAgentStatus, updateRunStatus, updateTaskStatus, applyRunReplyBookkeeping } from './lifecycle.js'
import {
  publishAgentStatus,
  publishMessageCreated,
  publishRunUpdated,
  publishTaskUpdated,
} from './realtime.js'
import { drainPendingThreadMessagesBestEffort } from '../thread-serialization.js'
import type { ExecutionDependencies, RunContext, RunPlanContext } from './types.js'
import type { BudgetStopStats } from './budget-stop.js'
import { createAgentMessage } from './agent-message.js'
import { enqueueInteractiveReplyPush } from './reply-push.js'

// A run that ends because a human requested cancellation through
// `POST /api/runs/:id/cancel`. The cooperative flag on the Run row is polled by
// the agentic loop between iterations and tool-call batches; when it exits, this
// module gives the run a stable, user-facing outcome — mirroring the budget-stop
// framing — instead of a silent empty reply. Partial assistant text is always
// delivered with the notice appended.

// Human-readable notice appended to (or standing in for) the run's reply so the
// user always sees why the run stopped. `hadPartialText` switches between "the
// answer above is incomplete" and "no answer was produced" framing, matching
// `buildBudgetStopNotice`.
export const buildCancelStopNotice = (hadPartialText: boolean): string =>
  hadPartialText
    ? '_⚠️ This run was cancelled. The answer above may be incomplete — '
      + 'send a new message to continue._'
    : '⚠️ This run was cancelled before it produced an answer. '
      + 'Send a new message to try again.'

// Structured, queryable record of the cancellation on the run's task, mirroring
// the `run.budget_exhausted` event (the Run row has no metadata column). Carries
// who requested the cancel and when so the audit trail is complete.
export const recordCancelStopEvent = async (
  prisma: PrismaClient,
  taskId: string,
  input: {
    cancelledByUserId: string | null
    cancelRequestedAt: Date | null
    hadPartialText: boolean
    stats: BudgetStopStats
  },
): Promise<void> => {
  await prisma.taskEvent.create({
    data: {
      eventType: 'run.cancelled',
      payload: {
        cancelRequestedAt: input.cancelRequestedAt?.toISOString() ?? null,
        cancelledByUserId: input.cancelledByUserId,
        costCents: input.stats.totalCostCents,
        hadPartialText: input.hadPartialText,
        iterations: input.stats.iterations,
        tokensUsed: input.stats.totalTokensUsed,
        toolCallsUsed: input.stats.toolCallsUsed,
        wallclockMs: input.stats.wallclockMs,
      },
      taskId,
    },
  })
}

// Terminalize a cancelled run: post the terminal message (partial answer with
// the notice appended, or the notice alone), persist the tokens/cost the run
// spent, flip the run/task to `cancelled`, and emit the same realtime + plan
// finalization the completion/failure paths use. Kept separate from
// `completeRunExecution` because that path forces `completed`; cancellation must
// leave the run `cancelled` for the status/restart surfaces.
export const finalizeCancelledRun = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  planContext: RunPlanContext | null,
  input: {
    invocations: InvocationRecord[]
    responseText: string
    hadPartialText: boolean
    notice: string
  },
): Promise<void> => {
  await persistInvocationLedgerEvents(deps.prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    invocations: input.invocations,
    runId: context.run.id,
  })

  const terminalContent = input.hadPartialText
    ? `${input.responseText}\n\n${input.notice}`
    : input.notice

  // Partial text is drawn from the same context the completed reply would have
  // used, so cancellation stamps exactly like completion.
  const message = await createAgentMessage(deps.prisma, context, {
    agentId: context.agent.id,
    content: terminalContent,
    role: 'assistant',
    threadId: context.run.threadId,
    ...(context.replyRootMessageId
      ? { rootMessageId: context.replyRootMessageId }
      : {}),
  })

  const reply = await applyRunReplyBookkeeping(deps.prisma, context, message.createdAt)

  // Partial text is drawn from the same context the completed reply would have
  // used, so cancellation publishes exactly like completion: a restricted
  // partial answer closes the stream without its content, and the WS event
  // carries no preview. Neither wire can be filtered per viewer.
  const restricted = message.basis.length > 0

  await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
    agentId: parseAgentId(context.agent.id),
    content: restricted ? '' : terminalContent,
    createdAt: message.createdAt.toISOString(),
    messageId: message.id,
    runId: parseRunId(context.run.id),
    ...(restricted ? { restricted: true } : {}),
  })
  await publishMessageCreated(deps.realtimeTransport, context, {
    content: terminalContent,
    messageId: message.id,
    role: 'assistant',
    ...(restricted ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })
  const replyPushMessage = {
    content: message.content,
    contentVisibility: message.basis.length > 0 ? 'generic' as const : 'full' as const,
    id: message.id,
  }

  await updateRunStatus(deps.prisma, context.run.id, 'cancelled')
  await updateTaskStatus(deps.prisma, context.task.id, 'cancelled')
  if (planContext) {
    await markRunPlanFinished(deps.prisma, {
      artifacts: { cancelled: true },
      planId: planContext.planId,
      rootStepId: planContext.rootStepId,
      success: false,
      summary: 'Run cancelled by user',
    })
  }
  await markDelegationStepFinished(deps.prisma, {
    artifacts: {
      cancelled: true,
      runId: context.run.id,
      taskId: context.task.id,
    },
    planId: payload.parentPlanId,
    planStepId: payload.parentPlanStepId,
    success: false,
    summary: 'Run cancelled by user',
  })
  await maybeContinueParentWorkflow(deps, payload, {
    output: {
      cancelled: true,
      runId: context.run.id,
      taskId: context.task.id,
    },
    success: false,
    summary: 'Run cancelled by user',
  })
  await setAgentStatus(deps.prisma, context.agent.id, 'idle')
  await publishRunUpdated(deps.realtimeTransport, context, 'cancelled')
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'cancelled',
  )
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: 'idle',
  })
  // A cancelled run still releases the (agent, thread) slot: pended messages
  // are delivered as one batched follow-up run (see thread-serialization.ts).
  await drainPendingThreadMessagesBestEffort(deps.prisma, {
    agentId: context.agent.id,
    ...(context.run.principalUserId ? { principalUserId: context.run.principalUserId } : {}),
    threadId: context.run.threadId,
  })
  await enqueueInteractiveReplyPush(deps, payload, context, replyPushMessage)
}

// The whole cancel outcome, from the loop's `cancelled` exit to a terminalized
// run: build the notice, read who asked and when, record the queryable event,
// then finalize. The caller only decides *whether* the run was cancelled.
export const handleCancelStop = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  planContext: RunPlanContext | null,
  loopResult: {
    invocations: InvocationRecord[]
    iterations: number
    toolCallsUsed: number
    totalCostCents: number
    totalTokensUsed: number
    wallclockMs: number
  },
  responseText: string,
): Promise<void> => {
  const hadPartialText = responseText.trim().length > 0
  const cancelState = await deps.prisma.run.findUnique({
    where: { id: context.run.id },
    select: { cancelRequestedAt: true, cancelRequestedByUserId: true },
  })
  await recordCancelStopEvent(deps.prisma, context.task.id, {
    cancelRequestedAt: cancelState?.cancelRequestedAt ?? null,
    cancelledByUserId: cancelState?.cancelRequestedByUserId ?? null,
    hadPartialText,
    stats: {
      iterations: loopResult.iterations,
      toolCallsUsed: loopResult.toolCallsUsed,
      totalCostCents: loopResult.totalCostCents,
      totalTokensUsed: loopResult.totalTokensUsed,
      wallclockMs: loopResult.wallclockMs,
    },
  })
  await finalizeCancelledRun(deps, payload, context, planContext, {
    hadPartialText,
    invocations: loopResult.invocations,
    notice: buildCancelStopNotice(hadPartialText),
    responseText,
  })
}
