// The subscriber side of the one shared `/api/events/stream` connection.
//
// Kept apart from the transport so "does a throwing subscriber cost its sibling
// the frame?" and "does the last unsubscribe close the connection?" are
// answerable without a fetch, a token, or a fake DOM.

import type { SseFrame } from '../../lib/sse'

/**
 * What a subscriber needs to know about the connection a frame arrived on.
 *
 * The route takes no filter parameters, so every subscriber sees every frame
 * this user may see. What differs is what each one does with a *replayed*
 * frame, and that decision needs to know whether this connection resumed from a
 * `Last-Event-ID` or opened cold.
 */
export type EventStreamConnection = {
  openedAt: number
  resumed: boolean
}

export type EventStreamListener = (
  frame: SseFrame,
  connection: EventStreamConnection,
) => Promise<void> | void

export type FrameFanout = {
  deliver: (frame: SseFrame, connection: EventStreamConnection) => Promise<void>
  size: () => number
  subscribe: (listener: EventStreamListener) => () => void
}

export const createFrameFanout = (): FrameFanout => {
  const listeners = new Set<EventStreamListener>()

  return {
    // Started together and awaited as a batch, never one after another. The
    // drain still waits for every subscriber before it reads the next frame, so
    // each keeps the back-pressure it had while it owned a connection — but the
    // notifier fetching a channel list can no longer hold the alert bell's frame
    // behind it, which is a delay neither could impose on the other while they
    // had a socket each. Failures are contained per subscriber because the
    // connection is now shared: an escaping throw would drop the socket, and
    // with it the other subscriber's events, over something only one cared about.
    deliver: async (frame, connection) => {
      await Promise.all(
        [...listeners].map(async (listener) => {
          try {
            await listener(frame, connection)
          } catch {
            // The subscriber's own problem; never the stream's.
          }
        }),
      )
    },
    size: () => listeners.size,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
