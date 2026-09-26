// One `/api/events/stream` connection per signed-in session, fanned out in the
// client.
//
// The route takes no query parameters: it derives the subscription from the
// actor's own channel scopes and sends every event that user may see
// (`api/src/routes/events.ts`), so there is nothing to narrow per connection.
// The alerts bell and the message notifier each used to open one anyway and
// parse every frame twice, each discarding the other's events — and since the
// route marks presence per connection, one of them closing marked the user
// offline while the other was still reading.

import { useEffect, useRef } from 'react'
import { getBaseUrl } from '../../lib/api-client'
import { readSseStream } from '../../lib/sse'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  classifyStreamResponse,
  runStreamConnectionLoop,
  type StreamAttemptOutcome,
} from '../threads/stream-retry'
import {
  createFrameFanout,
  type EventStreamConnection,
  type EventStreamListener,
} from './event-stream-fanout'

const baseUrl = getBaseUrl()

const fanout = createFrameFanout()

type ActiveConnection = {
  stop: () => void
  token: string
}

let active: ActiveConnection | null = null

// Where the stream resumes. Owned by the stream rather than by a subscriber: a
// resume has to pick up where the socket stopped, not where the newest
// subscriber attached. It also outlives one connection, because a renewed
// access token reopens the stream (the bearer travels as a header) roughly
// every half hour; reopening from nothing had the hub replay the user's whole
// retained backlog, up to 5,000 events, each refetching its queries at once.
// The hub filters replay to the connecting user's own scopes, so a carried
// cursor only skips events already delivered. Signing out clears it.
let lastEventId = ''

const openConnection = (token: string): ActiveConnection => {
  let cancelled = false
  let controller: AbortController | null = null

  const attempt = async (): Promise<StreamAttemptOutcome> => {
    const connection: EventStreamConnection = {
      openedAt: Date.now(),
      resumed: lastEventId !== '',
    }
    const request = new AbortController()
    controller = request

    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      }
      if (lastEventId) {
        headers['Last-Event-ID'] = lastEventId
      }

      const response = await fetch(`${baseUrl}/api/events/stream`, {
        headers,
        signal: request.signal,
      })

      const outcome = classifyStreamResponse(response)
      if (outcome !== 'connected' || !response.body) {
        return outcome
      }

      try {
        await readSseStream(response.body, async (frame) => {
          // A stopped connection may still flush a frame its successor has
          // already replayed; it must not move the shared cursor back.
          if (frame.id && !cancelled) {
            lastEventId = frame.id
          }
          await fanout.deliver(frame, connection)
        })
      } catch {
        // Dropped mid-stream. The response itself was a readable stream, so
        // this is still 'connected'; whether it earns a backoff reset depends
        // on how long the cycle lasted, which the loop times
        // (STREAM_HEALTHY_CONNECTION_MS).
      }
      return 'connected'
    } finally {
      if (controller === request) {
        controller = null
      }
    }
  }

  const handle: ActiveConnection = {
    stop: () => {
      cancelled = true
      controller?.abort()
    },
    token,
  }

  void runStreamConnectionLoop({
    attempt,
    isCancelled: () => cancelled,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then(() => {
    // The loop ends only on cancellation or on a response reconnecting cannot
    // fix. Either way this handle is spent, so drop it: the next subscriber to
    // mount opens a fresh connection rather than inheriting a dead one.
    if (active === handle) {
      active = null
    }
  })

  return handle
}

const stopConnection = (): void => {
  active?.stop()
  active = null
}

/**
 * Join the shared stream as one subscriber and return the leave function.
 *
 * The first subscriber opens the connection and the last one to leave closes
 * it; a rotated token reopens it, resuming after the last event it delivered,
 * because the bearer travels as a request header.
 */
export const attachEventStream = (
  token: string,
  listener: EventStreamListener,
): (() => void) => {
  const unsubscribe = fanout.subscribe(listener)
  if (active?.token !== token) {
    stopConnection()
    active = openConnection(token)
  }

  return () => {
    unsubscribe()
    if (fanout.size() === 0) {
      stopConnection()
    }
  }
}

/** Signed out: the next session, whoever it belongs to, starts afresh. */
export const forgetEventStreamPosition = (): void => {
  lastEventId = ''
}

/**
 * Attach to the shared event stream for as long as `enabled` holds.
 * `onFrame` is read through a ref, so a subscriber may rebuild its handler
 * every render without churning the socket.
 */
export const useEventStream = (input: {
  enabled: boolean
  onFrame: EventStreamListener
}): void => {
  const { token } = useAuthSession()
  const latestOnFrame = useRef(input.onFrame)
  latestOnFrame.current = input.onFrame

  useEffect(() => {
    if (!token) {
      forgetEventStreamPosition()
      return
    }
    if (!input.enabled) {
      return
    }

    return attachEventStream(
      token,
      (frame, connection) => latestOnFrame.current(frame, connection),
    )
  }, [input.enabled, token])
}
