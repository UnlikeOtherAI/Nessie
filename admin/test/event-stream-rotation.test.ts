import assert from 'node:assert/strict'
import test from 'node:test'

import type { SseFrame } from '../src/lib/sse.js'
import type { EventStreamConnection } from '../src/facades/realtime/event-stream-fanout.js'
import {
  attachEventStream,
  forgetEventStreamPosition,
} from '../src/facades/realtime/event-stream.js'

// A renewed access token reopens the shared stream, because the bearer is a
// request header. It used to reopen with no `Last-Event-ID`, so every renewal
// (about every 28 minutes) had the hub replay the user's whole retained
// backlog, and each replayed frame refetched its queries in the same instant —
// the burst that reached UOA as ~100 `/org/me` reads per renewal.

type Opened = { authorization: string | null; lastEventId: string | null }

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'timed out waiting for the stream')
}

test('a rotated token resumes after the last delivered event; signing out starts afresh', async () => {
  const opened: Opened[] = []
  const encoder = new TextEncoder()
  let nextId = 41
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    opened.push({
      authorization: headers.get('authorization'),
      lastEventId: headers.get('last-event-id'),
    })
    nextId += 1
    const id = nextId
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`id: ${id}\nevent: message.new\ndata: {}\n\n`))
        init?.signal?.addEventListener('abort', () => {
          controller.error(new DOMException('aborted', 'AbortError'))
        })
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch

  const received: Array<{ frame: SseFrame; connection: EventStreamConnection }> = []
  const listener = (frame: SseFrame, connection: EventStreamConnection) => {
    received.push({ frame, connection })
  }

  try {
    let leave = attachEventStream('token-a', listener)
    await waitFor(() => received.length === 1)
    assert.deepEqual(opened[0], { authorization: 'Bearer token-a', lastEventId: null })
    assert.equal(received[0]?.connection.resumed, false)

    // Renewal: the effect leaves with the old token and joins with the new one.
    leave()
    leave = attachEventStream('token-b', listener)
    await waitFor(() => received.length === 2)
    assert.deepEqual(opened[1], { authorization: 'Bearer token-b', lastEventId: '42' })
    assert.equal(received[1]?.connection.resumed, true)

    // Sign-out, then a new session: nothing carries over.
    leave()
    forgetEventStreamPosition()
    leave = attachEventStream('token-c', listener)
    await waitFor(() => received.length === 3)
    assert.deepEqual(opened[2], { authorization: 'Bearer token-c', lastEventId: null })
    assert.equal(received[2]?.connection.resumed, false)
    leave()
  } finally {
    globalThis.fetch = originalFetch
    forgetEventStreamPosition()
  }
})
