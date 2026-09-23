import {
  TICKET_EVENT_FOLLOW_KINDS,
  TICKET_FOLLOW_WAKE_REASONS,
  type ColumnCategory,
  type TaskEventOrigin,
  type TicketChangedStoredConfig,
  type TicketTriggerDeliverySource,
  type TicketTriggerEventType,
  type TicketTriggerSkipReason,
  type TicketWorkStatus,
  type TicketWorkWakeReason,
} from '@nessie/schemas'

/**
 * What one `TaskEvent` means for one `ticket_changed` trigger — the rule in
 * docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "Dispatch", over
 * facts already loaded, so it is pure and every branch is a unit test.
 *
 * **The origin rule** applies to pickup, re-entry and follow alike: only a
 * `session` event — a person's own session — by someone who can edit the
 * board starts, resumes or steers work. A board-source event may wake live
 * work when the trigger sets `follow.includeSourceEvents`, and never starts or
 * resumes it. Agents, tokens and the platform never do any of the three.
 *
 * An event the trigger has nothing to do with — a kind it does not follow, a
 * column that is neither start-work nor end, a ticket it has no work on — is
 * `ignore` and writes no delivery. Every event it *would* act on writes one,
 * delivered or skipped with its reason, so nothing is dropped unexplained.
 */
export type TicketEventFacts = {
  eventType: TicketTriggerEventType
  /** `system` when the payload carries no origin that parses: fail closed. */
  origin: TaskEventOrigin
  /** A `session` author who can edit the board right now. False for every other origin. */
  authorCanEditBoard: boolean
  /** `column_entered`: the column entered. `created`: the column the ticket landed in. */
  toColumnId: string | null
  /** `column_entered`: the column left, or null when the ticket had none. */
  fromColumnId: string | null
}

export type TicketTriggerFacts = {
  agentId: string
  config: TicketChangedStoredConfig
  /** The trigger's board's columns, to resolve `endOn` categories. */
  columns: readonly { id: string; category: ColumnCategory }[]
}

/**
 * The trigger's work record for this ticket: the live one, or — for an end —
 * the one this event's own move just ended (teardown runs in the move).
 */
export type TicketWorkFacts = { id: string; status: TicketWorkStatus; live: boolean }

export type TicketTriggerDecision =
  | { kind: 'ignore' }
  | { kind: 'skip'; source: TicketTriggerDeliverySource; reason: TicketTriggerSkipReason }
  | { kind: 'pickup'; source: 'pickup'; wakeReason: 'pickup' }
  | { kind: 'reentry' | 'end'; source: 'follow'; workId: string; wakeReason: 'ticket_moved' }
  | {
      kind: 'follow'
      source: 'follow'
      workId: string
      wakeReason: TicketWorkWakeReason
      untrusted: boolean
    }

const IGNORE: TicketTriggerDecision = { kind: 'ignore' }

const ORIGIN_REFUSALS = {
  agent: 'agent_origin',
  token: 'token_origin',
  source: 'source_origin',
  system: 'system_origin',
} as const satisfies Record<Exclude<TaskEventOrigin['kind'], 'session'>, TicketTriggerSkipReason>

/** Null when the origin rule admits the event; otherwise why not. */
export const originRuleRefusal = (
  event: Pick<TicketEventFacts, 'origin' | 'authorCanEditBoard'>,
  options: { admitSource: boolean },
): TicketTriggerSkipReason | null => {
  if (event.origin.kind === 'session') return event.authorCanEditBoard ? null : 'not_board_editor'
  if (event.origin.kind === 'source' && options.admitSource) return null
  return ORIGIN_REFUSALS[event.origin.kind]
}

/** The column ids an `endOn` list names on this board. */
export const endColumnIds = (
  config: Pick<TicketChangedStoredConfig, 'endOn'>,
  columns: TicketTriggerFacts['columns'],
): Set<string> => {
  const ids = new Set<string>()
  for (const entry of config.endOn) {
    if ('id' in entry) ids.add(entry.id)
    else for (const column of columns) if (column.category === entry.category) ids.add(column.id)
  }
  return ids
}

const skip = (
  source: TicketTriggerDeliverySource,
  reason: TicketTriggerSkipReason,
): TicketTriggerDecision => ({ kind: 'skip', source, reason })

/** A move or create into a start-work column, with no live work on the ticket. */
const decidePickup = (
  event: TicketEventFacts,
  pickupColumnIds: ReadonlySet<string>,
): TicketTriggerDecision => {
  const refusal = originRuleRefusal(event, { admitSource: false })
  if (refusal) return skip('pickup', refusal)
  // Only entering the pickup set starts work: a move from one start-work
  // column to another is not a new decision to start it.
  if (event.fromColumnId && pickupColumnIds.has(event.fromColumnId)) {
    return skip('pickup', 'already_in_pickup_column')
  }
  return { kind: 'pickup', source: 'pickup', wakeReason: 'pickup' }
}

export const decideTicketTrigger = (
  event: TicketEventFacts,
  trigger: TicketTriggerFacts,
  work: TicketWorkFacts | null,
): TicketTriggerDecision => {
  const pickupColumnIds = new Set(trigger.config.pickup?.columnIds ?? [])
  const liveWork = work?.live ? work : null

  if (event.eventType === 'created') {
    return event.toColumnId && pickupColumnIds.has(event.toColumnId)
      ? decidePickup(event, pickupColumnIds)
      : IGNORE
  }

  if (event.eventType === 'column_entered' && event.toColumnId) {
    // End first: a column that ends work never starts it.
    if (endColumnIds(trigger.config, trigger.columns).has(event.toColumnId)) {
      if (!work) return IGNORE
      // The agent's own move wakes nothing, so it cannot loop on itself;
      // teardown already ran in the move whoever made it.
      if (event.origin.kind === 'agent' && event.origin.agentId === trigger.agentId) {
        return skip('follow', 'own_agent_event')
      }
      return { kind: 'end', source: 'follow', workId: work.id, wakeReason: 'ticket_moved' }
    }
    if (pickupColumnIds.has(event.toColumnId)) {
      if (!liveWork) return decidePickup(event, pickupColumnIds)
      // Re-entry is a follow on the same record, never a second pickup, and a
      // source can never resume work — so a refusal leaves a parked record
      // parked.
      const refusal = originRuleRefusal(event, { admitSource: false })
      if (refusal) return skip('follow', refusal)
      return { kind: 'reentry', source: 'follow', workId: liveWork.id, wakeReason: 'ticket_moved' }
    }
  }

  const kind = TICKET_EVENT_FOLLOW_KINDS[event.eventType]
  if (!kind || !liveWork || !trigger.config.follow.kinds.includes(kind)) return IGNORE
  // A queued ticket's priority re-sorts the queue; it has nothing to tell the agent.
  if (kind === 'priority' && liveWork.status === 'queued') return skip('follow', 'priority_while_queued')
  const refusal = originRuleRefusal(event, { admitSource: trigger.config.follow.includeSourceEvents })
  if (refusal) return skip('follow', refusal)
  return {
    kind: 'follow',
    source: 'follow',
    workId: liveWork.id,
    wakeReason: TICKET_FOLLOW_WAKE_REASONS[kind],
    untrusted: event.origin.kind === 'source',
  }
}
