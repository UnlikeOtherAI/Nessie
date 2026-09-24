import {
  DEFAULT_TICKET_FOLLOW_KINDS,
  TICKET_QUIET_WAKE_MINUTES,
  TICKET_TRIGGER_LIMIT_CEILINGS,
  TICKET_TRIGGER_LIMIT_DEFAULTS,
  TicketChangedWorkConfigSchema,
  type ColumnCategory,
  type TicketFollowKind,
} from '@nessie/schemas'

import type { ChannelRecord } from '../../../lib/api-client'
import { groupTriggerRefusals, refusalFieldIn, type TriggerFieldErrors } from './trigger-refusals'

/**
 * The `ticket_changed` half of the Triggers editor as form state, and the
 * typed config it posts (`TicketChangedTriggerConfigSchema`,
 * docs/standards/ticket-work.md → "A ticket trigger's configuration is
 * resolved on the server"). The editor picks columns, so it names them by id;
 * the server checks every field again and refuses field by field, and those
 * refusals land on the field they name (`ticketRefusalField`).
 */

export type TicketInstructionSection =
  | 'general'
  | 'onPickup'
  | 'onTicketChanged'
  | 'onSessionTurnEnded'
  | 'onReminder'
  | 'onQueued'

export type TicketTriggerFormState = {
  boardId: string
  pickupColumnIds: string[]
  assignOnPickup: boolean
  followKinds: TicketFollowKind[]
  includeSourceEvents: boolean
  endOnTodo: boolean
  endOnDone: boolean
  endOnColumnIds: string[]
  wakesPerTicket: string
  startsPerDay: string
  /** The quiet wake: on, after this many minutes; off posts null. */
  quietWakeEnabled: boolean
  quietWakeMinutes: string
  instructions: Record<TicketInstructionSection, string>
}

export const TICKET_INSTRUCTION_SECTIONS: readonly {
  key: TicketInstructionSection
  label: string
  hint: string
}[] = [
  { key: 'general', label: 'Every wake', hint: 'What the agent does with every ticket. Every wake shows it first.' },
  { key: 'onPickup', label: 'When work starts', hint: 'Added when a person starts work on a ticket.' },
  {
    key: 'onTicketChanged',
    label: 'When the ticket changes',
    hint: 'Added for a comment, an edit, a move or a message in the work thread.',
  },
  {
    key: 'onReminder',
    label: 'When a reminder fires',
    hint: 'Added when a reminder the agent set fires, or when it is woken because nothing else was scheduled.',
  },
  {
    key: 'onSessionTurnEnded',
    label: 'When a coding session ends a turn',
    hint: 'Added when a coding session working the ticket ends a turn.',
  },
  { key: 'onQueued', label: 'When the ticket waits', hint: 'Added when the ticket has to wait its turn.' },
]

/**
 * A neutral example: how sectioned instructions read, not what this agent
 * should do. Whoever sets the trigger up writes the real ones.
 */
export const TICKET_INSTRUCTIONS_EXAMPLE: Partial<Record<TicketInstructionSection, string>> = {
  general: 'Read the ticket, its comments and its documents. Keep the ticket up to date with short comments.',
  onPickup: 'Comment a plan on the ticket. If something is unclear, ask in a comment and wait for an answer.',
  onTicketChanged: 'Read what changed. If it changes the plan, say how in a comment.',
}

export const TICKET_FOLLOW_KIND_OPTIONS: readonly { kind: TicketFollowKind; label: string }[] = [
  { kind: 'comment', label: 'A comment' },
  { kind: 'description', label: 'An edited description' },
  { kind: 'moved', label: 'A move to another column' },
  { kind: 'thread_message', label: 'A message in its work thread' },
  { kind: 'document', label: 'An edit to one of its documents' },
  { kind: 'priority', label: 'A changed priority' },
  { kind: 'labels', label: 'Changed labels' },
  { kind: 'assignee', label: 'A changed assignee' },
]

const emptyInstructions = (): Record<TicketInstructionSection, string> => ({
  general: '',
  onPickup: '',
  onQueued: '',
  onReminder: '',
  onSessionTurnEnded: '',
  onTicketChanged: '',
})

export const getDefaultTicketState = (
  prefill?: { boardId?: string; pickupColumnIds?: string[] },
): TicketTriggerFormState => ({
  boardId: prefill?.boardId ?? '',
  pickupColumnIds: prefill?.pickupColumnIds ?? [],
  assignOnPickup: true,
  followKinds: [...DEFAULT_TICKET_FOLLOW_KINDS],
  includeSourceEvents: false,
  endOnTodo: true,
  endOnDone: true,
  endOnColumnIds: [],
  wakesPerTicket: String(TICKET_TRIGGER_LIMIT_DEFAULTS.wakesPerTicket),
  startsPerDay: String(TICKET_TRIGGER_LIMIT_DEFAULTS.startsPerDay),
  quietWakeEnabled: true,
  quietWakeMinutes: String(TICKET_QUIET_WAKE_MINUTES.default),
  instructions: emptyInstructions(),
})

/** The stored, resolved config read back into the form. */
export const ticketStateFromConfig = (config: unknown): TicketTriggerFormState => {
  const parsed = TicketChangedWorkConfigSchema.safeParse(config)
  if (!parsed.success) return getDefaultTicketState()
  const stored = parsed.data
  const instructions = emptyInstructions()
  for (const [key, value] of Object.entries(stored.instructions ?? {})) {
    if (typeof value === 'string') instructions[key as TicketInstructionSection] = value
  }
  return {
    boardId: stored.boardId,
    pickupColumnIds: stored.pickup?.columnIds ?? [],
    assignOnPickup: stored.pickup?.assignOnPickup ?? true,
    followKinds: [...stored.follow.kinds],
    includeSourceEvents: stored.follow.includeSourceEvents,
    endOnTodo: stored.endOn.some((end) => 'category' in end && end.category === 'todo'),
    endOnDone: stored.endOn.some((end) => 'category' in end && end.category === 'done'),
    endOnColumnIds: stored.endOn.flatMap((end) => ('id' in end ? [end.id] : [])),
    wakesPerTicket: String(stored.limits.wakesPerTicket),
    startsPerDay: String(stored.limits.startsPerDay),
    quietWakeEnabled: stored.quietWakeMinutes !== null,
    quietWakeMinutes: String(stored.quietWakeMinutes ?? TICKET_QUIET_WAKE_MINUTES.default),
    instructions,
  }
}

/** Whether a column would end the work — and so cannot also start it. */
export const columnEndsWork = (
  state: Pick<TicketTriggerFormState, 'endOnColumnIds' | 'endOnDone' | 'endOnTodo'>,
  column: { id: string; category: ColumnCategory },
): boolean =>
  (state.endOnTodo && column.category === 'todo')
  || (state.endOnDone && column.category === 'done')
  || state.endOnColumnIds.includes(column.id)

const readLimit = (value: string, ceiling: number): number | null => {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= ceiling ? parsed : null
}

/** The quiet wake's minutes, or undefined for a value the server would refuse. */
const readQuietMinutes = (value: string): number | undefined => {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed >= TICKET_QUIET_WAKE_MINUTES.min && parsed <= TICKET_QUIET_WAKE_MINUTES.max
    ? parsed
    : undefined
}

export type TicketConfigResult =
  | { config: Record<string, unknown> }
  | { error: string; field: TicketFormField }

/** The typed `ticket_changed` config the create and update routes accept. */
export const buildTicketConfig = (state: TicketTriggerFormState): TicketConfigResult => {
  if (!state.boardId) return { error: 'Choose the board whose tickets this trigger works.', field: 'boardId' }
  const general = state.instructions.general.trim()
  if (!general) {
    return { error: 'Say what the agent does with every ticket; every wake shows it first.', field: 'instructions' }
  }
  const wakesPerTicket = readLimit(state.wakesPerTicket, TICKET_TRIGGER_LIMIT_CEILINGS.wakesPerTicket)
  const startsPerDay = readLimit(state.startsPerDay, TICKET_TRIGGER_LIMIT_CEILINGS.startsPerDay)
  if (wakesPerTicket === null || startsPerDay === null) {
    return {
      error: `Each limit is a whole number from 1 to ${TICKET_TRIGGER_LIMIT_CEILINGS.wakesPerTicket}.`,
      field: 'limits',
    }
  }
  const quietWakeMinutes = state.quietWakeEnabled ? readQuietMinutes(state.quietWakeMinutes) : null
  if (quietWakeMinutes === undefined) {
    return {
      error: `The quiet wake is a whole number of minutes from ${TICKET_QUIET_WAKE_MINUTES.min} to `
        + `${TICKET_QUIET_WAKE_MINUTES.max}, or off.`,
      field: 'quietWakeMinutes',
    }
  }
  const sections = Object.fromEntries(
    TICKET_INSTRUCTION_SECTIONS
      .map(({ key }) => [key, state.instructions[key].trim()] as const)
      .filter(([, text]) => text.length > 0),
  )
  return {
    config: {
      boardId: state.boardId,
      pickup: state.pickupColumnIds.length > 0
        ? { assignOnPickup: state.assignOnPickup, columns: state.pickupColumnIds.map((id) => ({ id })) }
        : null,
      follow: { includeSourceEvents: state.includeSourceEvents, kinds: state.followKinds },
      endOn: [
        ...(state.endOnTodo ? [{ category: 'todo' }] : []),
        ...(state.endOnDone ? [{ category: 'done' }] : []),
        ...state.endOnColumnIds.map((id) => ({ id })),
      ],
      quietWakeMinutes,
      limits: { startsPerDay, wakesPerTicket },
      instructions: sections,
    },
  }
}

/** The editor's fields a server refusal can land on. */
export type TicketFormField =
  | 'targetChannelId'
  | 'boardId'
  | 'pickup'
  | 'follow'
  | 'endOn'
  | 'limits'
  | 'quietWakeMinutes'
  | 'instructions'

const FIELD_ROOTS: readonly TicketFormField[] = [
  'targetChannelId', 'boardId', 'pickup', 'follow', 'endOn', 'limits', 'quietWakeMinutes', 'instructions',
]

/** `pickup.columns[0]` → `pickup`: the field a refusal's path names, or null for one the editor has no field for. */
export const ticketRefusalField = (path: string): TicketFormField | null => refusalFieldIn(FIELD_ROOTS, path)

export type TicketFieldErrors = TriggerFieldErrors<TicketFormField>

/**
 * A `TRIGGER_CONFIG_REFUSED` answer's refusals, grouped by the field each
 * lands on, with whatever the editor cannot place kept for the form's banner.
 */
export const groupTicketRefusals = (details: unknown): { fields: TicketFieldErrors; rest: string[] } =>
  groupTriggerRefusals(details, ticketRefusalField)

/**
 * A channel a ticket or document trigger may work in: an ordinary, live,
 * public channel of a project. The server checks this again
 * (`resolveTriggerTargetChannel`, one rule for both types), and why it must
 * be public is said beside the field.
 */
export const isTicketTargetChannel = (channel: ChannelRecord): boolean =>
  channel.type === 'standard'
  && !channel.systemChannelType
  && !channel.isGroupDm
  && channel.scope !== 'standalone'
  && channel.visibility === 'public'
  && !channel.archivedAt

export const TICKET_TARGET_CHANNEL_HINT =
  'Only public project channels are listed: every ticket gets its own work thread here, and everyone '
  + 'who can read a ticket has to be able to open it.'
