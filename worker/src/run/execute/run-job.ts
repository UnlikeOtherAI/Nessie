import { markRecallsInjected } from '@nessie/memory'
import {
  attributionFromActorContext,
  BUILTIN_TOOL_DEFINITIONS,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseRunId,
  parseThreadId,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { buildMcpToolset } from '../mcp-toolset.js'
import { ensureRunPlanContext, markRunPlanStarted } from '../plans.js'
import { resolveAgentTools } from '../tool-policy.js'
import { runExecutionAgentLoop } from './agent-loop.js'
import { applyBudgetGate } from './budget-gate.js'
import { completeRunExecution } from './completion.js'
import { handleRunExecutionFailure } from './failure.js'
import {
  claimRunForExecution,
  loadRunContext,
  setAgentStatus,
  updateTaskStatus,
} from './lifecycle.js'
import { buildMemoryContext, retrieveRelevantMemories, stripLeadingSectionTag } from './memory.js'
import { buildModelPrompt, loadConversation } from './prompt.js'
import { validateRunActorContext } from './policy.js'
import { publishAgentStatus, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import { buildScopes } from './scopes.js'
import { loadAllowedToolIds } from './tool-registry.js'
import type { ExecutionDependencies, RunPlanContext } from './types.js'

export const executeRunJob = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
): Promise<void> => {
  // Idempotency guard: skip if this run already reached a terminal state.
  //
  // We deliberately do NOT skip `running` runs: the queue renews each job's
  // lock while its handler is in flight (see PgQueueProvider.withLockRenewal),
  // so a live worker's run is never re-claimed concurrently. A run that is
  // still `running` when re-claimed therefore means the previous worker
  // crashed, and re-execution is the intended recovery path.
  const existingRun = await deps.prisma.run.findUnique({
    where: { id: payload.runId },
    select: { status: true, finishedAt: true },
  })
  if (
    existingRun
    && (existingRun.status === 'completed'
      || existingRun.status === 'failed'
      || existingRun.status === 'cancelled')
  ) {
    console.log(`[worker] Skipping already-${existingRun.status} run ${payload.runId}`)
    return
  }

  const context = await loadRunContext(deps.prisma, payload)
  if (!context) {
    return
  }

  const message = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { content: true },
  })

  if (!message) {
    return
  }

  const prompt = payload.promptOverride?.trim() || message.content
  let streamStarted = false
  let planContext: RunPlanContext | null = null

  try {
    await validateRunActorContext(deps.prisma, payload.actorContext, context)

    const budgetGate = await applyBudgetGate(deps, context, payload)
    if (budgetGate.blocked) {
      return
    }

    planContext = await ensureRunPlanContext(deps.prisma, {
      agentId: context.agent.id,
      channelId: context.channel.id,
      createdByActorId: payload.actorContext.actor.actorId,
      createdByActorType: payload.actorContext.actor.actorType,
      goal: prompt,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })

    const claimed = await claimRunForExecution(deps.prisma, context.run.id)
    if (!claimed) {
      console.log(`[worker] run ${context.run.id} already claimed or terminal; skipping`)
      return
    }
    await updateTaskStatus(deps.prisma, context.task.id, 'in_progress')
    await markRunPlanStarted(deps.prisma, planContext)
    await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
    await publishRunUpdated(deps.realtimeTransport, context, 'running')
    await publishTaskUpdated(
      deps.realtimeTransport,
      buildScopes(context),
      context.task.id,
      'in_progress',
    )
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'thinking',
    })

    const allowedToolIds = await loadAllowedToolIds(deps.prisma, context)

    const agentRecord = await deps.prisma.agent.findUnique({
      where: { id: context.agent.id },
      select: { toolPolicy: true, parentAgentId: true },
    })
    const toolPolicy = agentRecord?.toolPolicy as Record<string, boolean> | null ?? null
    const { descriptors: toolDefs, allowedIds: resolvedToolIds } = resolveAgentTools(
      allowedToolIds,
      BUILTIN_TOOL_DEFINITIONS,
      toolPolicy,
      context.agent.parentAgentId,
    )

    const mcpToolset = await buildMcpToolset(
      deps.prisma,
      context.channel.organizationId,
      toolPolicy,
      attributionFromActorContext(payload.actorContext, {
        agentId: context.agent.id,
        runId: context.run.id,
      }),
    )

    const conversation = await loadConversation(deps.prisma, context.run.threadId)
    const memories = await retrieveRelevantMemories(deps, context, payload, prompt)
    const injectedRecallIds = memories.flatMap((memory) =>
      memory.recallId ? [memory.recallId] : [],
    )
    const memoryContext = buildMemoryContext(memories)

    if (injectedRecallIds.length > 0) {
      await markRecallsInjected(injectedRecallIds, deps.searchConfig.pool)
    }

    const initialMessages = buildModelPrompt(
      conversation,
      context,
      prompt,
      memoryContext,
    )

    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.start', {
      agentId: parseAgentId(context.agent.id),
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })
    streamStarted = true

    const loopResult = await runExecutionAgentLoop(deps, payload, context, {
      allowedToolIds,
      budgetModelOverride: budgetGate.modelOverride,
      initialMessages,
      mcpToolset,
      resolvedToolIds,
      toolDefs,
      toolPolicy,
    })

    const responseText = stripLeadingSectionTag(loopResult.finalText)

    await completeRunExecution(deps, payload, context, planContext, {
      invocations: loopResult.invocations,
      iterations: loopResult.iterations,
      memories,
      responseText,
      toolCallsUsed: loopResult.toolCallsUsed,
    })
  } catch (error) {
    await handleRunExecutionFailure(deps, payload, context, {
      error,
      planContext,
      streamStarted,
    })

    throw error
  }
}
