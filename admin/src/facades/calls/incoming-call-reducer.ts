import type {
  CallIncomingEvent,
  CallInviteUpdatedEvent,
  CallUpdatedEvent,
} from '@nessie/schemas'

export type IncomingCallEvent =
  | { data: CallIncomingEvent; event: 'call.incoming' }
  | { data: CallInviteUpdatedEvent; event: 'call.invite.updated' }
  | { data: CallUpdatedEvent; event: 'call.updated' }

export type IncomingCallState = {
  calls: Map<string, CallIncomingEvent>
  inviteUpdates: Map<string, CallInviteUpdatedEvent>
  lastEventId: bigint | null
  tombstones: Map<string, number>
  updates: Map<string, CallUpdatedEvent>
}

export const initialIncomingCallState = (): IncomingCallState => ({
  calls: new Map(),
  inviteUpdates: new Map(),
  lastEventId: null,
  tombstones: new Map(),
  updates: new Map(),
})

const terminalInviteStates = new Set<CallInviteUpdatedEvent['state']>([
  'accepted',
  'cancelled',
  'declined',
  'missed',
])

const terminalCallStates = new Set<CallUpdatedEvent['status']>([
  'cancelled',
  'declined',
  'ended',
  'missed',
])

const parseEventId = (eventId: string): bigint | null => {
  try {
    return BigInt(eventId)
  } catch {
    return null
  }
}

const isNewer = (current: number | undefined, revision: number): boolean =>
  current === undefined || revision >= current

/**
 * Applies persisted user-call events monotonically. A terminal revision is a
 * tombstone: replayed rings at that revision or older can never revive it.
 */
export const reduceIncomingCallEvent = (
  state: IncomingCallState,
  input: { currentUserId: string; event: IncomingCallEvent; eventId: string; now: number },
): IncomingCallState => {
  const eventId = parseEventId(input.eventId)
  if (eventId === null || (state.lastEventId !== null && eventId <= state.lastEventId)) return state

  const next: IncomingCallState = {
    calls: new Map(state.calls),
    inviteUpdates: new Map(state.inviteUpdates),
    lastEventId: eventId,
    tombstones: new Map(state.tombstones),
    updates: new Map(state.updates),
  }
  const { event } = input

  if (event.event === 'call.incoming') {
    const current = next.calls.get(event.data.callId)
    const tombstoneRevision = next.tombstones.get(event.data.callId)
    if (
      Date.parse(event.data.expiresAt) > input.now
      && isNewer(current?.revision, event.data.revision)
      && (tombstoneRevision === undefined || event.data.revision > tombstoneRevision)
    ) {
      next.calls.set(event.data.callId, event.data)
    }
    return next
  }

  if (event.event === 'call.invite.updated') {
    const existing = next.inviteUpdates.get(event.data.callId)
    if (isNewer(existing?.revision, event.data.revision)) {
      next.inviteUpdates.set(event.data.callId, event.data)
    }
    if (event.data.userId === input.currentUserId && terminalInviteStates.has(event.data.state)) {
      const currentTombstone = next.tombstones.get(event.data.callId)
      if (isNewer(currentTombstone, event.data.revision)) {
        next.tombstones.set(event.data.callId, event.data.revision)
        next.calls.delete(event.data.callId)
      }
    }
    return next
  }

  const existing = next.updates.get(event.data.callId)
  if (isNewer(existing?.revision, event.data.revision)) {
    next.updates.set(event.data.callId, event.data)
  }
  if (terminalCallStates.has(event.data.status)) {
    const currentTombstone = next.tombstones.get(event.data.callId)
    if (isNewer(currentTombstone, event.data.revision)) {
      next.tombstones.set(event.data.callId, event.data.revision)
      next.calls.delete(event.data.callId)
    }
  }
  return next
}

export const liveIncomingCalls = (state: IncomingCallState, now: number): CallIncomingEvent[] =>
  [...state.calls.values()]
    .filter((call) => Date.parse(call.expiresAt) > now)
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
