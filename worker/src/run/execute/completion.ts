import { Prisma } from '@prisma/client'
import { markRecallsReferenced } from '@nessie/memory'
import { parseAgentId, parseRunId } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'
import { persistInvocationLedgerEvents } from '../inference.js'
import { enqueueRunMemoryConsolidation } from '../memory-consolidation.js'
import { markDelegationStepFinished, markRunPlanFinished } from '../plans.js'
import { buildScopes } from './scopes.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus } from './lifecycle.js'
import { detectReferencedRecallIds } from './memory.js'
import { maybeContinueParentWorkflow } from './parent-workflow.js'
import { publishAgentStatus, publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
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
    responseText: string
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

  const assistantMessage = await deps.prisma.message.create({
    data: delegatedOwnerId
      ? {
          content: input.responseText,
          metadata: {
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
        },
  })

  await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
    agentId: parseAgentId(context.agent.id),
    content: input.responseText,
    createdAt: assistantMessage.createdAt.toISOString(),
    messageId: assistantMessage.id,
    runId: parseRunId(context.run.id),
  })

  await publishMessageCreated(deps.realtimeTransport, context, {
    authoredByOwner: delegatedOwnerId !== null,
    content: input.responseText,
    messageId: assistantMessage.id,
    role: delegatedOwnerId ? 'user' : 'assistant',
  })

  await updateRunStatus(deps.prisma, context.run.id, 'completed')
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
