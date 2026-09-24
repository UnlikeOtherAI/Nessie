import { TICKET_WORK_PURPOSE } from '@nessie/schemas'
import { CHECK_BACK_IN_RANGE_REFUSAL, setAgentReminder } from '@nessie/team-admin'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { result } from './ticket-context.js'

/**
 * `check_back_in { minutes, note }`: a one-off reminder the agent sets for
 * itself (docs/standards/ticket-work.md → "Reminders, the quiet wake and the
 * sweep"). The integer schema lets the dispatcher's argument coercion turn
 * "15" into 15 before this runs; anything still not a whole number in range
 * is refused with the range, so a weak model can correct itself.
 *
 * Whose reminder it is comes from the run, never from the arguments: a
 * `ticket.work` run's reminder belongs to its own work record, and any other
 * run's to its own conversation. Nothing here reads the run's person — the
 * reminder wakes the agent as itself.
 */

const SUMMARY = 'check_back_in'

const clock = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

export const runCheckBackInTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { minutes, note } = input
  if (typeof minutes !== 'number') throw new Error(CHECK_BACK_IN_RANGE_REFUSAL(minutes))
  const actionContext = context.actorContext.actionContext
  const ticketWork = actionContext.purpose === TICKET_WORK_PURPOSE
  const workId = ticketWork ? actionContext.ticketWorkId ?? null : null
  if (ticketWork && !workId) {
    throw new Error('This ticket work run names no work record, so a reminder would wake nothing.')
  }
  const set = await setAgentReminder(context.prisma, {
    agentId: context.agentId,
    threadId: context.run.threadId,
    runId: context.run.id,
    minutes,
    note: typeof note === 'string' ? note : '',
    workId,
    principalUserId: context.run.principalUserId ?? null,
  })
  if (!set.ok) throw new Error(set.refusal)
  const { reminder } = set
  const lines = [
    `Reminder set | reminderId=${reminder.id}`,
    `You will be woken in this conversation at ${clock(reminder.dueAt)} (in ${minutes} minutes): ${reminder.note}`,
    ...(set.replaced ? ['It replaces this ticket\'s earlier pending reminder.'] : []),
    workId
      ? 'It counts as one of this ticket\'s wakes when it fires. End your turn now.'
      : 'You will wake as yourself, with nobody behind the run. End your turn now.',
  ]
  return result(SUMMARY, `minutes=${minutes}`, lines.join('\n'))
}

/** Dispatched by id, beside the other table-dispatched tools. */
export const REMINDER_TOOL_RUNNERS: Readonly<Record<string, typeof runCheckBackInTool>> = {
  check_back_in: runCheckBackInTool,
}
