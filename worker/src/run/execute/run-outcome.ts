import type { DeepWaterHandoffRunLocator, InvocationRecord } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import type { LoopResult } from '../agentic-loop.js'
import { persistInvocationLedgerEvents } from '../inference.js'
import { classifyBudgetStop } from './budget-stop.js'
import { handleCancelStop } from './cancel-stop.js'
import { completeRunExecution } from './completion.js'
import { prepareApprovalSuspend, suspendRunForApproval } from './approval-suspend.js'
import { prepareCardSuspend, suspendRunForCard } from './card-suspend.js'
import type { DocumentStreamRecorder } from './document-stream.js'
import { handleRunExecutionFailure } from './failure.js'
import { stripLeadingSectionTag } from './memory.js'
import type { RunInference } from './run-inference.js'
import type { RunExecutionSetup } from './run-setup.js'
import {
  applyRunStopContinuation,
  prepareRunStop,
  prepareWindDownHandover,
} from './run-stop.js'
import type { ExecutionDependencies, RunContext, RunPlanContext } from './types.js'
import { resolveRollingWatch } from './watch-status-gate.js'
import { isContentlessAfterReacting } from './working-marker.js'

export type RunLoopOutcome = 'cancelled' | 'completed' | 'failed' | null

/**
 * Finish a successful loop or one of its classified stops. Keeping this
 * separate from run claiming makes the approval interruption follow the same
 * checkpoint-first terminal discipline as budget and cancellation stops.
 */
export const handleRunLoopOutcome = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    documentStream: DocumentStreamRecorder
    handoffLocator: DeepWaterHandoffRunLocator | null
    inference: RunInference
    invocations: InvocationRecord[]
    loopResult: LoopResult
    planContext: RunPlanContext
    prompt: string
    reacted: boolean
    setup: RunExecutionSetup
    streamStarted: boolean
  },
): Promise<RunLoopOutcome> => {
  const responseText = stripLeadingSectionTag(input.loopResult.finalText)

  if (input.loopResult.pendingApproval && !input.handoffLocator) {
    // A gate is an interruption, not a completed tool call: no partially
    // streamed document may become durable while the run waits for a human.
    await input.documentStream.finalizeOutstanding('approval_required')
    const suspendPlan = await prepareApprovalSuspend(deps, context, {
      approval: {
        id: input.loopResult.pendingApproval.approvalId,
        toolName: input.loopResult.pendingApproval.toolName,
      },
      goal: input.prompt,
      inference: input.inference,
      invocationSink: input.invocations,
      lastAssistantText: responseText,
      messages: input.loopResult.messages,
      priorGeneration: input.setup.checkpoint?.generation ?? 0,
    })
    await suspendRunForApproval(deps, payload, context, {
      ...suspendPlan,
      invocations: input.loopResult.invocations,
      responseText,
    })
    return null
  }

  if (input.loopResult.pendingInput && !input.handoffLocator) {
    // Waiting on a card is an interruption like an approval: nothing
    // half-streamed becomes durable while a person is deciding.
    await input.documentStream.finalizeOutstanding('card_response')
    const suspendPlan = await prepareCardSuspend(deps, context, {
      cardId: input.loopResult.pendingInput.cardId,
      goal: input.prompt,
      inference: input.inference,
      invocationSink: input.invocations,
      lastAssistantText: responseText,
      messages: input.loopResult.messages,
      priorGeneration: input.setup.checkpoint?.generation ?? 0,
    })
    await suspendRunForCard(deps, payload, context, {
      ...suspendPlan,
      invocations: input.loopResult.invocations,
      responseText,
    })
    return null
  }

  if (input.loopResult.cancelled && !input.handoffLocator) {
    await input.documentStream.finalizeOutstanding('cancelled')
    await handleCancelStop(
      deps,
      payload,
      context,
      input.planContext,
      input.loopResult,
      responseText,
    )
    return 'cancelled'
  }

  if (input.loopResult.exhaustedBudget && !input.handoffLocator) {
    await input.documentStream.finalizeOutstanding('budget_stopped')
    const hadPartialText = responseText.trim().length > 0
    const stopPlan = await prepareRunStop(deps, payload, context, {
      goal: input.prompt,
      hadPartialText,
      inference: input.inference,
      invocationSink: input.invocations,
      loopResult: {
        ...input.loopResult,
        exhaustedBudget: input.loopResult.exhaustedBudget,
      },
      priorGeneration: input.setup.checkpoint?.generation ?? 0,
    })
    if (hadPartialText) {
      await completeRunExecution(deps, payload, context, input.planContext, {
        invocations: input.loopResult.invocations,
        iterations: input.loopResult.iterations,
        memories: input.setup.memories,
        messageMetadata: { runStop: stopPlan.runStopMetadata },
        responseText: `${responseText}\n\n${stopPlan.notice}`,
        toolCallsUsed: input.loopResult.toolCallsUsed,
      })
    } else {
      await persistInvocationLedgerEvents(deps.prisma, {
        actorContext: payload.actorContext,
        agentId: context.agent.id,
        invocations: input.loopResult.invocations,
        runId: context.run.id,
      })
      await handleRunExecutionFailure(deps, payload, context, {
        error: new Error(`Run stopped at ${classifyBudgetStop(input.loopResult.exhaustedBudget)}`),
        planContext: input.planContext,
        streamStarted: input.streamStarted,
        terminalMessage: stopPlan.notice,
        terminalMessageMetadata: { runStop: stopPlan.runStopMetadata },
      })
    }
    // Enqueued only after this run is terminal, so the per-(agent, thread)
    // single-run invariant is never broken to force a continuation.
    await applyRunStopContinuation(deps, payload, context, stopPlan)
    return hadPartialText ? 'completed' : 'failed'
  }

  const windDownMetadata =
    input.loopResult.woundDown
    && !input.handoffLocator
    && responseText.trim().length > 0
      ? await prepareWindDownHandover(deps, payload, context, {
        goal: input.prompt,
        inference: input.inference,
        invocationSink: input.invocations,
        loopResult: input.loopResult,
        priorGeneration: input.setup.checkpoint?.generation ?? 0,
      })
      : null
  const rollingWatch = await resolveRollingWatch(deps, payload, context, {
    responseText,
    runUtility: input.inference.runUtility,
  })
  const reactionWasTheAnswer = isContentlessAfterReacting(input.reacted, responseText)

  await completeRunExecution(deps, payload, context, input.planContext, {
    invocations: input.loopResult.invocations,
    iterations: input.loopResult.iterations,
    memories: input.setup.memories,
    ...(windDownMetadata ? { messageMetadata: { runStop: windDownMetadata } } : {}),
    responseText,
    ...(rollingWatch ? { rollingWatch } : {}),
    ...(reactionWasTheAnswer ? { reactionWasTheAnswer: true } : {}),
    toolCallsUsed: input.loopResult.toolCallsUsed,
  })
  return 'completed'
}
