// What the shared `/api/events/stream` fan-out means for a ringing phone.
//
// Kept apart from `IncomingCallProvider` so "does a replayed ring make sound?"
// is answerable without a fetch, a token, or a fake DOM — the same reason the
// stream's own subscriber side lives in `realtime/event-stream-fanout.ts`.

import { WsEventSchema, type CallIncomingEvent } from '@nessie/schemas'
import type { SseFrame } from '../../lib/sse'
import type { EventStreamConnection } from '../realtime/event-stream-fanout'
import type { IncomingCallEvent } from './incoming-call-reducer'

export const parseIncomingCallEvent = (frame: SseFrame): IncomingCallEvent | null => {
  if (!frame.data || !frame.id || !frame.event?.startsWith('call.')) return null
  try {
    const parsed = WsEventSchema.safeParse(JSON.parse(frame.data))
    if (!parsed.success) return null
    if (parsed.data.event === 'call.incoming') {
      return { data: parsed.data.data, event: 'call.incoming' }
    }
    if (parsed.data.event === 'call.invite.updated') {
      return { data: parsed.data.data, event: 'call.invite.updated' }
    }
    if (parsed.data.event === 'call.updated') {
      return { data: parsed.data.data, event: 'call.updated' }
    }
  } catch {
    // One malformed persisted event must not end a user's ring stream.
  }
  return null
}

/**
 * `ring` makes sound now, `verify` only after the live call route confirms the
 * invite is still ringing, `none` stays silent.
 */
export type RingIntent = 'none' | 'ring' | 'verify'

/**
 * A stream proves delivery, never that a stale ring still deserves attention.
 *
 * A connection that resumed from a `Last-Event-ID` replays whatever the hub
 * buffered while this tab was away, so every ring on it is reconciled against
 * the call route before it can make sound. A cold connection carries only what
 * arrived live, and an unexpired ring on it is news.
 */
export const resolveRingIntent = (input: {
  call: CallIncomingEvent
  connection: EventStreamConnection
  now: number
}): RingIntent => {
  if (input.connection.resumed) return 'verify'
  return Date.parse(input.call.expiresAt) > input.now ? 'ring' : 'none'
}
