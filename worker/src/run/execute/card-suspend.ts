import { type RunExecuteJobPayload } from '@nessie/schemas'
import type { InvocationRecord } from '@nessie/runtime'
import { Prisma } from '@prisma/client'

import {
  applySuspendedState,
  persistSuspensionCheckpoint,
  postSuspensionNotice,
} from './run-suspend.js'
import { generateCheckpointNote } from './run-stop.js'
import type { RunInference } from './run-inference.js'
import type { ExecutionDependencies, RunContext } from './types.js'

export type CardSuspendPlan = {
  cardId: string
  checkpointId: string
}

/**
 * Suspending a run on an interactive card posted with `wait: true`.
 *
 * Unlike an approval gate there is no notice to write: the card **is** the
 * notice, and it is already in the thread. Anything the model said in the same
 * turn is still its own words and is posted; silence posts nothing, so a bare
 * "here is a card" run adds exactly one message to the conversation.
 */
export const prepareCardSuspend = async (
  deps: ExecutionDependencies,
  context: RunContext,
  input: {
    cardId: string
    goal: string
    inference: RunInference
    invocationSink: InvocationRecord[]
    lastAssistantText: string
    messages: Parameters<typeof generateCheckpointNote>[2]['messages']
    priorGeneration: number
  },
): Promise<CardSuspendPlan> => {
  const checkpointId = await persistSuspensionCheckpoint(deps, context, {
    eventPayload: { cardId: input.cardId },
    goal: input.goal,
    inference: input.inference,
    invocationSink: input.invocationSink,
    lastAssistantText: input.lastAssistantText,
    messages: input.messages,
    priorGeneration: input.priorGeneration,
    reason: 'card_response',
  })
  return { cardId: input.cardId, checkpointId }
}

export const suspendRunForCard = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: CardSuspendPlan & {
    invocations: InvocationRecord[]
    responseText: string
  },
): Promise<void> => {
  const responseText = input.responseText.trim()
  if (responseText) {
    await postSuspensionNotice(deps, context, { content: responseText })
  }

  // The row carries what the press needs to bring this run back: which run to
  // resume, and the enqueue-time actor context to resume it as. Both are
  // server-authored, exactly as `ApprovalRequest.resumeState` is.
  await deps.prisma.agentCard.updateMany({
    data: {
      resumeState: {
        actorContext: payload.actorContext,
        interactive: payload.interactive ?? false,
        messageId: payload.messageId,
      } as Prisma.InputJsonValue,
      waitRunId: context.run.id,
    },
    where: { id: input.cardId, status: 'open', waitRunId: null },
  })

  await applySuspendedState(deps, payload, context, {
    agentStatus: 'waiting_input',
    invocations: input.invocations,
    runStatus: 'waiting_input',
  })
}
