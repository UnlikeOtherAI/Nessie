import { Prisma, type PrismaClient } from '@prisma/client'
import type { ProviderToolCall } from '@nessie/runtime'
import {
  PreparedCardActionsSchema,
  PreparedCardExecutionSchema,
  type PreparedCardExecution,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

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
 * Stable per card, so a crash-resumed run re-entering the call is answered by
 * the tool-effect ledger instead of running it again. Hyphens dropped to stay
 * inside every provider's tool-call id alphabet and length.
 */
const preparedToolCallId = (cardId: string): string => `prepared_${cardId.replaceAll('-', '')}`

export const claimPreparedCardCall = async (
  prisma: Pick<PrismaClient, 'agentCard'>,
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
  // taken and asks the model instead; only this very run, back after a crash
  // before its first checkpoint, may pick its own claim up again.
  const execution = PreparedCardExecutionSchema.safeParse(card.preparedExecution)
  const ours = execution.success && execution.data.runId === context.run.id && !execution.data.outcome
  if (!ours) {
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

/**
 * Whether the call finished on its own, for the card's note in later runs.
 * Best-effort: the run's outcome is already decided, and a missing note only
 * reads as "started".
 */
export const recordPreparedCardOutcome = async (
  prisma: Pick<PrismaClient, 'agentCard'>,
  prepared: PreparedCardCall,
  input: { preparedCompleted?: boolean; runId: string },
): Promise<void> => {
  const execution: PreparedCardExecution = {
    outcome: input.preparedCompleted ? 'succeeded' : 'handed_to_model',
    runId: input.runId,
  }
  await prisma.agentCard.updateMany({
    data: { preparedExecution: execution },
    where: { id: prepared.cardId },
  }).catch((error: unknown) => console.warn('[worker] prepared card outcome not recorded', error))
}
