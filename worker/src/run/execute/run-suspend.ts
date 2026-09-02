import { Prisma } from '@prisma/client'
import { parseAgentId, parseRunId, type RunExecuteJobPayload } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'

import { persistInvocationLedgerEvents } from '../inference.js'
import { createAgentMessage, runReplyBasis } from './agent-message.js'
import { persistRunCheckpoint } from './checkpoint.js'
import {
  applyRunReplyBookkeeping,
  setAgentStatus,
  updateRunStatus,
  updateTaskStatus,
} from './lifecycle.js'
import {
  publishAgentStatus,
  publishMessageCreated,
  publishRunUpdated,
  publishTaskUpdated,
} from './realtime.js'
import { generateCheckpointNote } from './run-stop.js'
import { buildScopes } from './scopes.js'
import type { RunInference } from './run-inference.js'
import type { ExecutionDependencies, RunContext } from './types.js'

/**
 * Suspending a run because a person owes it an answer.
 *
 * Two things do this — a tool call waiting on an approval, and an interactive
 * card waiting on a button press — and they are the same mechanism with a
 * different reason: write a checkpoint, say so in the thread, and park the run
 * in a non-terminal status that keeps the (agent, thread) slot held so nothing
 * else starts underneath it. The pieces live here so neither path can drift
 * from the other; each composes them with its own reason and notice.
 */

export type SuspendReason = 'approval_required' | 'card_response'

/**
 * The same checkpoint shape a budget stop writes, classified by why the run
 * stopped. The model-authored note stays untrusted; anything that must be
 * trustworthy on resume is server-authored on the approval or card row.
 */
export const persistSuspensionCheckpoint = async (
  deps: ExecutionDependencies,
  context: RunContext,
  input: {
    eventPayload: Record<string, Prisma.InputJsonValue>
    goal: string
    inference: RunInference
    invocationSink: InvocationRecord[]
    lastAssistantText: string
    messages: Parameters<typeof generateCheckpointNote>[2]['messages']
    priorGeneration: number
    reason: SuspendReason
  },
): Promise<string> => {
  const { note, sources } = await generateCheckpointNote(input.inference, input.invocationSink, {
    goal: input.goal,
    lastAssistantText: input.lastAssistantText,
    messages: input.messages,
  })
  const checkpointId = await persistRunCheckpoint(deps.prisma, {
    agentId: context.agent.id,
    basis: runReplyBasis(context),
    generation: input.priorGeneration + 1,
    note,
    organizationId: context.channel.organizationId,
    reason: input.reason,
    rootMessageId: context.replyRootMessageId ?? null,
    runId: context.run.id,
    sources,
    taskId: context.task.id,
    threadId: context.run.threadId,
  })
  await deps.prisma.taskEvent.create({
    data: {
      eventType: 'run.suspended',
      payload: {
        ...input.eventPayload,
        checkpointId,
        reason: input.reason,
        runId: context.run.id,
      },
      taskId: context.task.id,
    },
  })
  return checkpointId
}

/**
 * Post the message that tells the thread the run is waiting, through the one
 * disclosure-stamping chokepoint, and close the live stream behind it.
 */
export const postSuspensionNotice = async (
  deps: ExecutionDependencies,
  context: RunContext,
  input: { content: string; metadata?: Prisma.InputJsonValue },
): Promise<void> => {
  const message = await createAgentMessage(deps.prisma, context, {
    agentId: context.agent.id,
    content: input.content,
    role: 'assistant',
    threadId: context.run.threadId,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(context.replyRootMessageId ? { rootMessageId: context.replyRootMessageId } : {}),
  })
  const reply = context.replyRootMessageId
    ? await applyRunReplyBookkeeping(deps.prisma, context, message.createdAt)
    : undefined
  const restricted = message.basis.length > 0
  await publishMessageCreated(deps.realtimeTransport, context, {
    content: message.content,
    messageId: message.id,
    role: message.role,
    ...(restricted ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })
  await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
    agentId: parseAgentId(context.agent.id),
    content: restricted ? '' : message.content,
    createdAt: message.createdAt.toISOString(),
    messageId: message.id,
    runId: parseRunId(context.run.id),
    ...(restricted ? { restricted: true } : {}),
    ...(context.replyRootMessageId ? { rootMessageId: context.replyRootMessageId } : {}),
  })
}

/**
 * Park the run. The status is non-terminal by construction — `updateRunStatus`
 * only stamps `finishedAt` for the three terminal values — so the working
 * marker stays up and `ACTIVE_THREAD_RUN_STATUSES` keeps a second run from
 * starting in this thread while a person is deciding.
 */
export const applySuspendedState = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    agentStatus: 'waiting_approval' | 'waiting_input'
    invocations: InvocationRecord[]
    runStatus: 'waiting_approval' | 'waiting_input'
  },
): Promise<void> => {
  await persistInvocationLedgerEvents(deps.prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    invocations: input.invocations,
    runId: context.run.id,
  })
  await updateRunStatus(deps.prisma, context.run.id, input.runStatus)
  // The task-level meaning of both suspensions is the same — a person owes
  // this work an answer — so they share the one task status.
  await updateTaskStatus(deps.prisma, context.task.id, 'awaiting_approval')
  await setAgentStatus(deps.prisma, context.agent.id, input.agentStatus)
  await publishRunUpdated(deps.realtimeTransport, context, input.runStatus)
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'awaiting_approval',
  )
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: input.agentStatus,
  })
}
