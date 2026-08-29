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

const openConnection = (token: string): ActiveConnection => {
  let cancelled = false
  let controller: AbortController | null = null
  // Owned by the connection rather than by a subscriber: a resume has to pick
  // up where the socket stopped, not where the newest subscriber attached.
  let lastEventId = ''

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
          if (frame.id) {
            lastEventId = frame.id
          }
          await fanout.deliver(frame, connection)
        })
      } catch {
        // Dropped mid-stream. The connection itself worked, so this still
        // counts as connected and the next attempt starts at the base delay.
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
 * Attach to the shared event stream for as long as `enabled` holds.
 *
 * The first subscriber opens the connection and the last one to leave closes
 * it; a rotated token reopens it, because the bearer travels as a request
 * header. `onFrame` is read through a ref, so a subscriber may rebuild its
 * handler every render without churning the socket.
 */
export const useEventStream = (input: {
  enabled: boolean
  onFrame: EventStreamListener
}): void => {
  const { token } = useAuthSession()
  const latestOnFrame = useRef(input.onFrame)
  latestOnFrame.current = input.onFrame

  useEffect(() => {
    if (!input.enabled || !token) {
      return
    }

    const unsubscribe = fanout.subscribe(
      (frame, connection) => latestOnFrame.current(frame, connection),
    )
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
  }, [input.enabled, token])
}
