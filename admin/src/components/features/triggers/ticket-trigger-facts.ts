import {
  TicketChangedStoredConfigSchema,
  TicketQuietWakeMinutesSchema,
  TicketWaitingMachineHoursSchema,
} from '@nessie/schemas'

import { useProjectBoards } from '../../../facades/boards/hooks'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import type { KeyValueItem } from '../../shared/KeyValueList'
import { TICKET_FOLLOW_KIND_OPTIONS } from './ticket-trigger-form'
import type { TriggerRegistryMaps } from './trigger-presentation'

/**
 * A ticket trigger's facts on its own page, named from its board: which board,
 * which columns start and end the work, and what wakes the agent while it is
 * live. The stored config holds ids (the server resolved them), so the names
 * come from the board of the trigger's channel's project.
 */
export const useTicketTriggerFacts = (
  trigger: AgentTriggerRecord,
  registry: TriggerRegistryMaps,
): KeyValueItem[] => {
  const channel = trigger.targetChannelId ? registry.channelsById.get(trigger.targetChannelId) : undefined
  const isTicket = trigger.type === 'ticket_changed'
  const { data: boards = [] } = useProjectBoards(isTicket ? channel?.projectId : undefined)
  if (!isTicket) return []
  const parsed = TicketChangedStoredConfigSchema.safeParse(trigger.config)
  if (!parsed.success) return [{ label: 'Board', value: 'This trigger’s configuration needs attention.' }]
  const config = parsed.data
  const board = boards.find((candidate) => candidate.id === config.boardId)
  const columnName = (id: string) => board?.columns.find((column) => column.id === id)?.name ?? 'a removed column'
  const pickup = config.pickup?.columnIds ?? []
  const ends = config.endOn.map((end) =>
    'id' in end ? columnName(end.id) : end.category === 'todo' ? 'any To do column' : 'any Done column')
  const follows = TICKET_FOLLOW_KIND_OPTIONS
    .filter(({ kind }) => config.follow.kinds.includes(kind))
    .map(({ label }) => label.toLowerCase())
  return [
    { label: 'Board', value: board?.name ?? '—' },
    {
      label: 'Starts work',
      value: pickup.length > 0
        ? `When a person moves a ticket into ${pickup.map(columnName).join(', ')}`
          + (config.pickup?.assignOnPickup ? ', assigning it to the agent if nobody has it' : '')
        : 'Never: this trigger only follows work',
    },
    { label: 'Wakes on', value: follows.length > 0 ? follows.join(', ') : 'nothing' },
    ...(config.follow.includeSourceEvents
      ? [{ label: 'Connected board', value: 'Its own changes wake live work too, marked untrusted' }]
      : []),
    { label: 'Ends work', value: ends.length > 0 ? `When a ticket enters ${ends.join(', ')}` : 'Never' },
    { label: 'Quiet wake', value: quietWakeFact(config.quietWakeMinutes) },
    { label: 'Offline machine', value: waitingMachineFact(config.waitingMachineHours) },
  ]
}

/** How long work waits for its own machine to reconnect before another machine may take it. */
const waitingMachineFact = (stored: unknown): string => {
  const parsed = TicketWaitingMachineHoursSchema.safeParse(stored)
  const hours = parsed.success ? parsed.data : TicketWaitingMachineHoursSchema.parse(undefined)
  return `Work waits ${hours} ${hours === 1 ? 'hour' : 'hours'} for its machine to reconnect, then moves to another`
}

/** The quiet wake as the page says it: when live work nothing else will wake is checked on. */
const quietWakeFact = (stored: unknown): string => {
  const parsed = TicketQuietWakeMinutesSchema.safeParse(stored)
  const minutes = parsed.success ? parsed.data : TicketQuietWakeMinutesSchema.parse(undefined)
  return minutes === null
    ? 'Off'
    : `After ${minutes} minutes with nothing scheduled — no reminder, no question waiting for an answer`
}
