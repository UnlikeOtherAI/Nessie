// What the client does when the server says the replay it just sent was
// incomplete.
//
// `/api/events/stream` caps how many events one replay may carry
// (`MAX_REPLAY_EVENTS`). The cap used to be silent, which is the worst version
// of it: this client advances `Last-Event-ID` to the last event it received and
// carries on believing it is up to date, while the events the cap withheld are
// left behind for good — the connection stays open, every later live event
// moves the watermark further past them, and replay is `id > watermark`.
//
// The server now writes a `realtime.gap` frame (carrying no `id:`, so it does
// not move that watermark) at the end of a truncated replay, and the only
// honest answer to it is to stop trusting the stream for current state and read
// it again over REST. React Query already knows every REST read this session
// has made, so invalidating all of them *is* that bootstrap: active queries
// refetch immediately and everything else is marked stale for its next use.

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { SseFrame } from '../../lib/sse'
import { useEventStream } from './event-stream'

/** Must match `REALTIME_GAP_EVENT` in `api/src/realtime/notification-delivery.ts`. */
export const REALTIME_GAP_EVENT = 'realtime.gap'

/**
 * Pure so the decision can be tested without a socket, a query client or a DOM.
 * Deliberately keyed on the event name alone: the frame's `data` says *why* the
 * server gave up, and no reason changes what the client has to do about it.
 */
export const isRealtimeGapFrame = (frame: SseFrame): boolean =>
  frame.event === REALTIME_GAP_EVENT

/**
 * The bootstrap itself, as a plain function of a query client so it can be run
 * against a real one in a test rather than asserted about.
 *
 * No key filter: the stream feeds alerts, thread activity, unread counts,
 * channel lists and incoming calls, and a truncated replay says nothing about
 * which of them the withheld events touched. React Query answers this by
 * refetching every *active* query at once and marking the rest stale for their
 * next use, which is the REST re-read the marker asks for.
 */
export const createRealtimeGapBootstrap = (queryClient: QueryClient) => (): void => {
  void queryClient.invalidateQueries()
}

/**
 * The frame-handling decision, separated from React so "does a gap frame
 * trigger the bootstrap, and does anything else?" is answerable without a
 * socket, a token or a DOM. Returns whether it acted.
 */
export const handleRealtimeGapFrame = (frame: SseFrame, bootstrap: () => void): boolean => {
  if (!isRealtimeGapFrame(frame)) {
    return false
  }

  bootstrap()
  return true
}

/**
 * Mount once, in the shell — not per feature. The gap is a property of the one
 * shared connection, and one bootstrap answers it for every surface reading
 * from that connection; a copy per subscriber would refetch the whole cache
 * once per subscriber for a single gap.
 */
export const useRealtimeGapRecovery = (): void => {
  const queryClient = useQueryClient()

  useEventStream({
    enabled: true,
    onFrame: (frame) => {
      handleRealtimeGapFrame(frame, createRealtimeGapBootstrap(queryClient))
    },
  })
}
