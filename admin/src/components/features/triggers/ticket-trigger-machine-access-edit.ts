import { TicketChangedWorkConfigSchema, type AgentTriggerMachineAccessEffect } from '@nessie/schemas'

import type { AgentTriggerRecord } from '../../../lib/api-client'
import { buildTicketConfig, type TicketTriggerFormState } from './ticket-trigger-form'

/**
 * What saving a ticket trigger will do to the standing machine access it
 * holds, said before the save and after it (docs/standards/ticket-work.md →
 * "Limits and digests"; the server's judgement is team-admin's
 * `judgeStandingPolicyTermsChange`, over the terms executor-manage's
 * `standingPolicyTermsOf` pins).
 *
 * The pinned terms are the target channel, the board, the start-work columns
 * and whether a pickup assigns the ticket, what wakes the agent and whether a
 * connected board's own changes do, the columns that end work, every
 * instructions section word for word, the quiet wake, and the two limits the
 * trigger keeps. Changing any of them pauses the access until its author
 * confirms it again — whoever saves, the author included — except lowering a
 * limit, which keeps it on. The name and the description are not pinned; the
 * agent is not editable here, so it never differs.
 */

type StoredTicketTrigger = Pick<AgentTriggerRecord, 'config' | 'targetChannelId'>
type FormTarget = { targetChannelId: string; ticket?: TicketTriggerFormState }

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n')

const endOnKeys = (endOn: readonly ({ category: string } | { id: string })[]): string[] =>
  endOn.map((end) => ('category' in end ? `category:${end.category}` : `id:${end.id}`))

/**
 * Whether saving this form would pause the trigger's machine access. False
 * when the form would not save at all (its own error says why) or the stored
 * trigger cannot be read as a ticket trigger.
 */
export const ticketEditPausesMachineAccess = (stored: StoredTicketTrigger, form: FormTarget): boolean => {
  const before = TicketChangedWorkConfigSchema.safeParse(stored.config)
  if (!form.ticket || !before.success) return false
  const built = buildTicketConfig(form.ticket)
  if ('error' in built) return false
  const was = before.data
  const next = built.config as {
    boardId: string
    endOn: ({ category: string } | { id: string })[]
    follow: { includeSourceEvents: boolean; kinds: string[] }
    instructions: Record<string, string>
    limits: { startsPerDay: number; wakesPerTicket: number }
    pickup: { assignOnPickup: boolean; columns: { id: string }[] } | null
    quietWakeMinutes: number | null
  }
  // The server lays an edit's sections over the stored ones, one level deep.
  const wasInstructions = Object.fromEntries(Object.entries(was.instructions ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const instructions = { ...wasInstructions, ...next.instructions }
  const channel = form.targetChannelId || stored.targetChannelId
  const changed = channel !== stored.targetChannelId
    || next.boardId !== was.boardId
    || !sameSet(next.pickup?.columns.map((column) => column.id) ?? [], was.pickup?.columnIds ?? [])
    || (next.pickup?.assignOnPickup ?? false) !== (was.pickup?.assignOnPickup ?? false)
    || !sameSet(next.follow.kinds, was.follow.kinds)
    || next.follow.includeSourceEvents !== was.follow.includeSourceEvents
    || !sameSet(endOnKeys(next.endOn), endOnKeys(was.endOn))
    || next.quietWakeMinutes !== was.quietWakeMinutes
    || Object.entries(instructions).some(([key, text]) => wasInstructions[key] !== text)
  const raised = next.limits.wakesPerTicket > was.limits.wakesPerTicket
    || next.limits.startsPerDay > was.limits.startsPerDay
  return changed || raised
}

/** Said above Save while the form would pause live machine access. */
export const machineAccessEditWarning = (authorName: string): string =>
  `Saving pauses ${authorName}’s machine access until they re-confirm.`

/** Said once the save has landed, from what the server answered it did. */
export const machineAccessSavedLine = (effect: AgentTriggerMachineAccessEffect): string =>
  effect.kind === 'suspended'
    ? `Saved. ${effect.authorName}’s machine access is paused until they confirm it again; `
      + 'tickets being worked wait for it.'
    : 'Saved. Machine access stays on: lowering a limit needs no new confirmation.'
