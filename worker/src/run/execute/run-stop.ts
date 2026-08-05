import type { InvocationRecord, ProviderMessage } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import type { LoopResult } from '../agentic-loop.js'
import {
  buildBudgetStopNotice,
  classifyBudgetStop,
  recordBudgetStopEvent,
  type StopContinuation,
} from './budget-stop.js'
import {
  buildCheckpointNotePrompt,
  mechanicalCheckpointNote,
  parseCheckpointNote,
} from './checkpoint-note.js'
import { persistRunCheckpoint } from './checkpoint.js'
import { enqueueAutoContinuation, isInteractiveRun, shouldAutoContinue } from './continuation.js'
import type { RunInference } from './run-inference.js'
import type { ExecutionDependencies, RunContext } from './types.js'

// The graceful stop (spec §3, §5, §6): the loop has already reserved headroom,
// so the run can still afford one bounded model call to write down what it
// learned before the notice goes out.
//
// Everything here is best-effort around the *delivery* of the stop: a failed
// note, checkpoint, or continuation must never turn a stopped run into a
// crashed one — the user still gets their partial answer and an explanation.

export type RunStopPlan = {
  checkpointId: string | null
  continuation: StopContinuation
  notice: string
  /** Written onto the notice message so admin can render Continue (§6). */
  runStopMetadata: {
    checkpointId?: string
    continuable: boolean
    runId: string
    stopReason: string
  }
}

const generateCheckpointNote = async (
  inference: RunInference,
  invocationSink: InvocationRecord[],
  input: { goal: string; lastAssistantText: string; messages: ProviderMessage[] },
): Promise<{ note: string; sources: { title?: string; url: string }[] }> => {
  try {
    const result = await inference.runUtility(
      [{
        content: buildCheckpointNotePrompt({ goal: input.goal, messages: input.messages }),
        role: 'user',
      }],
      [],
    )
    invocationSink.push(...result.invocations)
    const raw = result.outputText?.trim()
    if (raw) return parseCheckpointNote(raw)
  } catch (error) {
    console.error('[worker] checkpoint note generation failed', error)
  }
  return mechanicalCheckpointNote({
    goal: input.goal,
    lastAssistantText: input.lastAssistantText,
  })
}

/**
 * Produce the checkpoint (note + row + `run.checkpointed` event) and decide how
 * the work gets continued, then build the member-visible notice.
 */
export const prepareRunStop = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    goal: string
    hadPartialText: boolean
    inference: RunInference
    invocationSink: InvocationRecord[]
    loopResult: LoopResult & { exhaustedBudget: NonNullable<LoopResult['exhaustedBudget']> }
    /** Generation of the checkpoint this run consumed, 0 when it started fresh. */
    priorGeneration: number
  },
): Promise<RunStopPlan> => {
  const stopReason = classifyBudgetStop(input.loopResult.exhaustedBudget)
  const generation = input.priorGeneration + 1

  let checkpointId: string | null = null
  try {
    const { note, sources } = await generateCheckpointNote(
      input.inference,
      input.invocationSink,
      {
        goal: input.goal,
        lastAssistantText: input.loopResult.finalText,
        messages: input.loopResult.messages,
      },
    )
    checkpointId = await persistRunCheckpoint(deps.prisma, {
      agentId: context.agent.id,
      generation,
      note,
      organizationId: context.channel.organizationId,
      reason: stopReason,
      rootMessageId: context.replyRootMessageId ?? null,
      runId: context.run.id,
      sources,
      taskId: context.task.id,
      threadId: context.run.threadId,
    })
  } catch (error) {
    console.error('[worker] failed to persist run checkpoint for run', context.run.id, error)
  }

  await recordBudgetStopEvent(
    deps.prisma,
    context.task.id,
    input.loopResult.exhaustedBudget,
    input.loopResult,
    input.hadPartialText,
    checkpointId,
  )

  const willAutoContinue = checkpointId !== null
    && shouldAutoContinue({ generation, payload })
  const continuation: StopContinuation = willAutoContinue
    ? { kind: 'auto', part: generation + 1 }
    : checkpointId !== null && isInteractiveRun(payload)
      ? { kind: 'reply' }
      : { kind: 'none' }

  return {
    checkpointId,
    continuation,
    notice: buildBudgetStopNotice(
      input.loopResult.exhaustedBudget,
      input.loopResult,
      input.hadPartialText,
      continuation,
    ),
    runStopMetadata: {
      ...(checkpointId ? { checkpointId } : {}),
      continuable: checkpointId !== null && continuation.kind === 'reply',
      runId: context.run.id,
      stopReason,
    },
  }
}

/**
 * Enqueue the continuation run planned by `prepareRunStop`. Called AFTER the
 * stopping run has been terminalized, so the (agent, thread) single-run
 * invariant holds; a busy slot means a follow-up run already exists and will
 * pick up the same checkpoint through the ordinary auto-load.
 */
export const applyRunStopContinuation = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  plan: RunStopPlan,
): Promise<void> => {
  if (plan.continuation.kind !== 'auto' || !plan.checkpointId) return
  try {
    const runId = await enqueueAutoContinuation(deps, payload, context, {
      checkpointId: plan.checkpointId,
    })
    if (runId) {
      console.log(`[worker] run ${context.run.id} auto-continued as ${runId}`)
    }
  } catch (error) {
    console.error('[worker] failed to enqueue auto-continuation for run', context.run.id, error)
  }
}
