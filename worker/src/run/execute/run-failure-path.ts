import {
  markAmbiguousDeepWaterHandoffRecoveryNeeded,
  markDeepWaterHandoffRecoveryNeeded,
  type DeepWaterHandoffRunLocator,
  type InvocationRecord,
} from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import {
  DeepWaterHandoffFatalError,
  type DeepWaterHandoffGuard,
} from '../deepwater-handoff-guard.js'
import { promoteUnresolvedDeepWaterHandoffError } from '../deepwater-handoff-failure.js'
import {
  isFinalQueueAttempt,
  shouldRetryRunWithoutTerminalizing,
  type QueueAttempt,
} from '../tool-execution-errors.js'
import type { DocumentStreamRecorder } from './document-stream.js'
import { handleRunExecutionFailure } from './failure.js'
import { persistInvocationLedgerEvents } from '../inference.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import type { ExecutionDependencies, RunContext, RunPlanContext } from './types.js'

/** Finish a failed run, or rethrow unchanged when its queue retry should own it. */
export const handleRunFailurePath = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    caughtError: unknown
    deepWaterHandoffGuard: DeepWaterHandoffGuard | null
    documentStream: DocumentStreamRecorder
    handoffLocator: DeepWaterHandoffRunLocator | null
    invocations: InvocationRecord[]
    planContext: RunPlanContext | null
    queueAttempt: QueueAttempt
    streamStarted: boolean
    thinkingRecorder: ThinkingRecorder
  },
): Promise<never> => {
  await input.thinkingRecorder.close()
  await input.documentStream.finalizeOutstanding('run_failed')
  await input.documentStream.close()
  const error = promoteUnresolvedDeepWaterHandoffError(
    input.caughtError,
    input.deepWaterHandoffGuard,
  )
  if (shouldRetryRunWithoutTerminalizing(error, input.queueAttempt)) throw error
  if (
    isFinalQueueAttempt(input.queueAttempt)
    && error instanceof DeepWaterHandoffFatalError
    && input.handoffLocator
  ) {
    if (error.handoffRunId) {
      await markDeepWaterHandoffRecoveryNeeded(deps.prisma, {
        ...input.handoffLocator,
        runId: error.handoffRunId,
      })
    } else {
      await markAmbiguousDeepWaterHandoffRecoveryNeeded(deps.prisma, input.handoffLocator)
    }
  }
  if (input.invocations.length > 0) {
    try {
      await persistInvocationLedgerEvents(deps.prisma, {
        actorContext: payload.actorContext,
        agentId: context.agent.id,
        invocations: input.invocations,
        runId: context.run.id,
      })
    } catch (ledgerError) {
      console.error(
        '[worker] failed to persist ledger events for failed run',
        context.run.id,
        ledgerError,
      )
    }
  }
  await handleRunExecutionFailure(deps, payload, context, {
    error,
    planContext: input.planContext,
    streamStarted: input.streamStarted,
  })
  throw error
}
