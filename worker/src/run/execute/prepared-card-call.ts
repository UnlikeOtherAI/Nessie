import { Prisma, type PrismaClient } from '@prisma/client'
import { judgePreparedOutcome, type ProviderToolCall, type RunDecisionEvaluator } from '@nessie/runtime'
import {
  PreparedCardActionsSchema,
  PreparedCardExecutionSchema,
  type PreparedCardExecution,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import type { AgenticLoopInput } from '../agentic-loop-types.js'
import type { RunContext } from './types.js'

/**
 * A pressed button's prepared call (docs/standards/agent-cards.md → "A
 * prepared button runs its call").
 *
 * The agent that posted the card wrote the call out in full — tool and
 * arguments — before anyone answered, so the answer is the only thing
 * missing, and the run that the answer starts executes the call before it
 * asks the model anything. Every fact here is structural: the card the run's
 * trigger answered (`AgentCard.responseMessageId`, written by the press or by
 * the one-on-one claim of a typed answer), the button it resolved with, and
 * the card belonging to the agent this run is.
 */
export type PreparedCardCall = { cardId: string; call: ProviderToolCall }

/**
 * A prepared call's id: stable per card, so a crash-resumed run re-entering
 * the call is answered by the tool-effect ledger instead of running it again,
 * and marked, so the ledger claims it whatever the tool's category — a
 * workspace tool a model calls is not claimed, but one the platform runs
 * without the model reading anything must never run twice
 * (`tool-effect-ledger.ts`). The id reaches the provider whenever the model
 * takes the call over, so it fits the strictest limit a provider sets: OpenAI
 * refuses a tool-call id over 40 characters, and `prep_` plus the card id's
 * 32 hex digits is 37.
 */
export const PREPARED_TOOL_CALL_ID_PREFIX = 'prep_'
const preparedToolCallId = (cardId: string): string =>
  `${PREPARED_TOOL_CALL_ID_PREFIX}${cardId.replaceAll('-', '')}`

export const claimPreparedCardCall = async (
  prisma: Pick<PrismaClient, 'agentCard' | 'run'>,
  payload: Pick<RunExecuteJobPayload, 'batchMessageIds' | 'messageId'>,
  context: { agent: Pick<RunContext['agent'], 'id'>; run: Pick<RunContext['run'], 'id'> },
): Promise<PreparedCardCall | null> => {
  // A run answering several queued messages owes the model all of them.
  if ((payload.batchMessageIds?.length ?? 0) > 1) return null
  const card = await prisma.agentCard.findUnique({
    where: { responseMessageId: payload.messageId },
    select: {
      agentId: true, id: true, preparedActions: true, preparedExecution: true,
      resolvedActionKey: true, status: true,
    },
  })
  if (!card || card.agentId !== context.agent.id || card.status !== 'resolved' || !card.resolvedActionKey) {
    return null
  }
  const prepared = PreparedCardActionsSchema.safeParse(card.preparedActions)
  const action = prepared.success ? prepared.data[card.resolvedActionKey] : undefined
  if (!action) return null

  // Claimed once. A restarted run or a second run on the same answer finds it
  // taken and asks the model instead. Two runs may pick a claim up again: this
  // very run, back after a crash before its first checkpoint, and the run that
  // continues the claiming run after a person approved the call, which runs
  // the exact call they approved rather than asking the model to rebuild it.
  const execution = PreparedCardExecutionSchema.safeParse(card.preparedExecution)
  const open = execution.success && !execution.data.outcome
  const ours = open && execution.data.runId === context.run.id
  if (!ours && open && await continues(prisma, context.run.id, execution.data.runId)) {
    const taken = await prisma.agentCard.updateMany({
      data: { preparedExecution: { runId: context.run.id } },
      where: { id: card.id, preparedExecution: { equals: execution.data } },
    })
    if (taken.count !== 1) return null
  } else if (!ours) {
    if (card.preparedExecution !== null) return null
    const claimed = await prisma.agentCard.updateMany({
      data: { preparedExecution: { runId: context.run.id } },
      where: { id: card.id, preparedExecution: { equals: Prisma.DbNull } },
    })
    if (claimed.count !== 1) return null
  }
  return {
    cardId: card.id,
    call: { arguments: action.arguments, toolCallId: preparedToolCallId(card.id), toolName: action.tool },
  }
}

/** A run the platform resumed from `claimant`: an approval's continuation. */
const continues = async (
  prisma: Pick<PrismaClient, 'run'>, runId: string, claimant: string,
): Promise<boolean> => {
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { continuationOfRunId: true } })
  return run?.continuationOfRunId === claimant
}

/**
 * What the agentic loop takes for a prepared call: the call to run first, and
 * the check that it did its job (`judgePreparedOutcome`). A run without Jev
 * (a personal subscription or a local model) cannot confirm, so it always
 * hands the result to the model.
 */
export const preparedLoopInput = (
  prepared: PreparedCardCall | null,
  decide: RunDecisionEvaluator | null,
): Pick<AgenticLoopInput, 'confirmPrepared' | 'preparedToolCalls'> => prepared
  ? {
      preparedToolCalls: [prepared.call],
      confirmPrepared: async (calls, results) => decide !== null && judgePreparedOutcome(decide, calls.map(
        (call, index) => ({
          arguments: call.arguments,
          result: (results.find((result) => result.toolCallId === call.toolCallId) ?? results[index])?.output ?? '',
          tool: call.toolName,
        }),
      )),
    }
  : {}

/**
 * Whether the call finished on its own, for the card's note in later runs.
 * Best-effort: the run's outcome is already decided, and a missing note only
 * reads as "started". A run that suspended (the call waits on an approval)
 * records nothing: the claim stays open for the run that continues it. A run
 * that ended before dispatching anything (stopped, cancelled, over budget
 * before its first batch) gives the claim back, because the call never ran
 * and a restart or continuation must still be able to run it.
 */
export const recordPreparedCardOutcome = async (
  prisma: Pick<PrismaClient, 'agentCard'>,
  prepared: PreparedCardCall,
  input: {
    pendingApproval?: unknown
    pendingInput?: unknown
    preparedCompleted?: boolean
    runId: string
    toolCallsUsed?: number
  },
): Promise<void> => {
  if (input.pendingApproval || input.pendingInput) return
  if (input.toolCallsUsed === 0) {
    const released: PreparedCardExecution = { runId: input.runId }
    await prisma.agentCard.updateMany({
      data: { preparedExecution: Prisma.DbNull },
      where: { id: prepared.cardId, preparedExecution: { equals: released } },
    }).catch((error: unknown) => console.warn('[worker] prepared card claim not released', error))
    return
  }
  const execution: PreparedCardExecution = {
    outcome: input.preparedCompleted ? 'succeeded' : 'handed_to_model',
    runId: input.runId,
  }
  await prisma.agentCard.updateMany({
    data: { preparedExecution: execution },
    where: { id: prepared.cardId },
  }).catch((error: unknown) => console.warn('[worker] prepared card outcome not recorded', error))
}
