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
// the burst that reached UOA as ~100 `/org/me` reads per renewal. The cursor
// belongs to one session scope (sub/org/proj/team), though: a team or account
// switch swaps the token for a different tenant's without passing through
// null, and resuming there would skip replaying that tenant's backlog.

type Opened = { authorization: string | null; lastEventId: string | null }

const baseClaims = {
  org: 'org-1',
  proj: 'proj-1',
  sub: 'user-1',
  team: 'team-1',
}

// A real-shaped unsigned JWT: the scope decoder reads only the payload, so
// the signature can be anything.
const tokenFor = (claims: Record<string, unknown>): string => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.test-signature`
}

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'timed out waiting for the stream')
}

// Each connection delivers exactly one frame with an increasing id, then
// holds the stream open until aborted.
const stubStream = (): { opened: Opened[]; restore: () => void } => {
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
  return {
    opened,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

type Received = Array<{ frame: SseFrame; connection: EventStreamConnection }>

const recorder = (into: Received) => (frame: SseFrame, connection: EventStreamConnection) => {
  into.push({ frame, connection })
}

test('a renewal with the same sub/org/proj/team resumes after the last delivered event', async () => {
  const { opened, restore } = stubStream()
  const received: Received = []
  try {
    let leave = attachEventStream(tokenFor({ ...baseClaims, iat: 1 }), recorder(received))
    await waitFor(() => received.length >= 1)
    assert.equal(opened[0]?.lastEventId, null)
    assert.equal(received[0]?.connection.resumed, false)

    // Renewal: same session scope, new token string.
    leave()
    leave = attachEventStream(tokenFor({ ...baseClaims, iat: 2 }), recorder(received))
    await waitFor(() => received.length >= 2)
    assert.equal(opened[1]?.lastEventId, '42')
    assert.equal(received[1]?.connection.resumed, true)
    leave()
  } finally {
    restore()
    forgetEventStreamPosition()
  }
})

test('a switch to a different org, project or team starts cold', async () => {
  const { opened, restore } = stubStream()
  const received: Received = []
  try {
    let leave = attachEventStream(tokenFor({ ...baseClaims, iat: 1 }), recorder(received))
    await waitFor(() => received.length >= 1)
    assert.equal(received[0]?.connection.resumed, false)

    for (const changed of [
      { ...baseClaims, org: 'org-2' },
      { ...baseClaims, proj: 'proj-2' },
      { ...baseClaims, team: 'team-2' },
    ]) {
      const framesBefore = received.length
      leave()
      leave = attachEventStream(tokenFor({ ...changed, iat: 2 }), recorder(received))
      await waitFor(() => received.length >= framesBefore + 1)
      assert.equal(opened.at(-1)?.lastEventId, null)
      assert.equal(received.at(-1)?.connection.resumed, false)
    }
    leave()
  } finally {
    restore()
    forgetEventStreamPosition()
  }
})

test('a switch to a different sub starts cold', async () => {
  const { opened, restore } = stubStream()
  const received: Received = []
  try {
    let leave = attachEventStream(tokenFor({ ...baseClaims, iat: 1 }), recorder(received))
    await waitFor(() => received.length >= 1)

    leave()
    leave = attachEventStream(tokenFor({ ...baseClaims, sub: 'user-2', iat: 2 }), recorder(received))
    await waitFor(() => received.length >= 2)
    assert.equal(opened[1]?.lastEventId, null)
    assert.equal(received[1]?.connection.resumed, false)
    leave()
  } finally {
    restore()
    forgetEventStreamPosition()
  }
})

test('an undecodable token starts cold', async () => {
  const { opened, restore } = stubStream()
  const received: Received = []
  try {
    let leave = attachEventStream(tokenFor({ ...baseClaims, iat: 1 }), recorder(received))
    await waitFor(() => received.length >= 1)

    leave()
    leave = attachEventStream('not-a-jwt', recorder(received))
    await waitFor(() => received.length >= 2)
    assert.equal(opened[1]?.lastEventId, null)
    assert.equal(received[1]?.connection.resumed, false)
    leave()
  } finally {
    restore()
    forgetEventStreamPosition()
  }
})

test('sign-out via forgetEventStreamPosition starts the next session cold', async () => {
  const { opened, restore } = stubStream()
  const received: Received = []
  try {
    let leave = attachEventStream(tokenFor({ ...baseClaims, iat: 1 }), recorder(received))
    await waitFor(() => received.length >= 1)

    // Sign-out, then a new session with the very same scope: nothing carries.
    leave()
    forgetEventStreamPosition()
    leave = attachEventStream(tokenFor({ ...baseClaims, iat: 2 }), recorder(received))
    await waitFor(() => received.length >= 2)
    assert.equal(opened[1]?.lastEventId, null)
    assert.equal(received[1]?.connection.resumed, false)
    leave()
  } finally {
    restore()
    forgetEventStreamPosition()
  }
})
