// What a LISTEN drop costs the connections a replica is *already* holding,
// and what now repays it (horizontal-scaling audit 2.2, overview row 3.5).
//
// The transport re-listens a second after a drop, which restores future
// notifications and nothing else. The clients on this replica never learn
// anything happened: their sockets are held open by the route's 15 s
// keepalives, so no reconnect fires, no `Last-Event-ID` is re-sent and nothing
// goes and fetches what the gap swallowed. The replica silently stops
// delivering events it should have delivered, and the only thing that
// eventually rescues such a client is its own next reconnect — which on an idle
// admin tab may be hours away.
//
// Every registered connection carries a watermark, so the gap is recoverable
// from this side. This pins that: after a re-listen, each connection is re-read
// from its own watermark, on both lanes.
//
// The hub owns a real pool and a real `PgRealtimeTransport`, so the transport's
// three database-facing methods are replaced for the length of each test. What
// is under test is the wiring — that `createRealtimeHub` hands `listen` a
// recovery hook at all, and that the hook repairs the connections it holds —
// not `pg`.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  PgRealtimeTransport,
  type RealtimeListenOptions,
  type RealtimeReplayEvent,
  type RealtimeReplayPage,
  type ThreadStreamEvent,
} from '@nessie/runtime'
import { parseAgentId, parseOrganizationId, parseRunId, parseUserId } from '@nessie/schemas'

import { createRealtimeHub } from '../src/realtime/hub.js'

const DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused'

type Recorder = {
  frames: () => string[]
  sink: ServerResponse
}

const createRecorder = (): Recorder => {
  const chunks: string[] = []
  return {
    frames: () => [...chunks],
    sink: {
      end: () => undefined,
      once: () => undefined,
      writableEnded: false,
      write: (chunk: string) => {
        chunks.push(chunk)
        return true
      },
    } as unknown as ServerResponse,
  }
}

/**
 * A stand-in for the two backlog reads, backed by arrays a test appends to.
 * `listen` records the options it was handed so the test can fire the recovery
 * hook the way a reconnect does.
 */
type Harness = {
  listenOptions: () => RealtimeListenOptions | undefined
  pushThreadEvent: (event: ThreadStreamEvent) => void
  pushUserEvent: (event: RealtimeReplayEvent) => void
  restore: () => void
  truncateNextUserReplay: (value: boolean) => void
}

const installTransportStubs = (): Harness => {
  const prototype = PgRealtimeTransport.prototype
  const original = {
    listRealtimeEventsAfter: prototype.listRealtimeEventsAfter,
    listThreadEvents: prototype.listThreadEvents,
    listen: prototype.listen,
  }

  const threadEvents: ThreadStreamEvent[] = []
  const userEvents: RealtimeReplayEvent[] = []
  let capturedOptions: RealtimeListenOptions | undefined
  let truncated = false

  prototype.listen = async function stubListen(
    _handler,
    options: RealtimeListenOptions = {},
  ): Promise<void> {
    capturedOptions = options
  }
  prototype.listThreadEvents = async function stubListThreadEvents(
    threadId: string,
    afterSequence = 0,
  ): Promise<ThreadStreamEvent[]> {
    return threadEvents.filter(
      (event) => event.threadId === threadId && event.sequence > afterSequence,
    )
  }
  prototype.listRealtimeEventsAfter = async function stubListRealtimeEventsAfter(input: {
    afterEventId: bigint
  }): Promise<RealtimeReplayPage> {
    return {
      events: userEvents.filter((event) => event.id > input.afterEventId),
      truncated,
    }
  }

  return {
    listenOptions: () => capturedOptions,
    pushThreadEvent: (event) => threadEvents.push(event),
    pushUserEvent: (event) => userEvents.push(event),
    restore: () => Object.assign(prototype, original),
    truncateNextUserReplay: (value) => {
      truncated = value
    },
  }
}

const threadEvent = (threadId: string, sequence: number): ThreadStreamEvent => ({
  data: {
    agentId: parseAgentId(randomUUID()),
    content: `chunk-${sequence}`,
    messageId: randomUUID(),
    runId: parseRunId(randomUUID()),
  },
  event: 'stream.done',
  sequence,
  threadId,
  ts: new Date().toISOString(),
})

const userEvent = (id: bigint): RealtimeReplayEvent => ({
  channelId: null,
  createdAt: new Date(),
  eventType: 'alert.created',
  id,
  payload: { data: {}, event: 'alert.created', ts: new Date().toISOString(), type: 'event' },
  recipientUserId: null,
})

const buildHub = async () =>
  createRealtimeHub({
    databaseUrl: DATABASE_URL,
    poolMax: 1,
    poolMin: 0,
    prisma: {} as unknown as PrismaClient,
  })

test('a LISTEN reconnect re-reads the thread backlog for a connection already registered', async () => {
  const harness = installTransportStubs()
  try {
    const threadId = randomUUID()
    harness.pushThreadEvent(threadEvent(threadId, 1))

    const hub = await buildHub()
    try {
      const recorder = createRecorder()
      const connection = await hub.addSseConnection(threadId, recorder.sink)
      assert.equal(recorder.frames().length, 1, 'the initial hydration writes the backlog it found')
      assert.equal(
        'lastSequence' in connection ? connection.lastSequence : -1,
        1,
        'and moves the watermark to it',
      )

      // The LISTEN connection drops here. Two events are published while it is
      // down: nothing arrives, and the client's socket stays open, so it has no
      // reason to reconnect and no way to know.
      harness.pushThreadEvent(threadEvent(threadId, 2))
      harness.pushThreadEvent(threadEvent(threadId, 3))
      assert.equal(
        recorder.frames().length,
        1,
        'a dropped LISTEN delivers nothing — this is the state the fix has to repair',
      )

      const options = harness.listenOptions()
      assert.ok(
        options?.onListenRecovered,
        'createRealtimeHub must give listen a recovery hook, or a re-listen repairs nothing',
      )
      await options.onListenRecovered()

      const frames = recorder.frames()
      assert.equal(frames.length, 3, 'both events published during the gap must be written')
      assert.ok(frames[1]?.includes('id: 2'), 'in id order, each carrying its own id')
      assert.ok(frames[2]?.includes('id: 3'))
      assert.equal(
        'lastSequence' in connection ? connection.lastSequence : -1,
        3,
        'and the watermark ends at the head of the log',
      )
      assert.equal(
        'hydrating' in connection ? connection.hydrating : true,
        false,
        'the connection is open to live delivery again',
      )
    } finally {
      await hub.close()
    }
  } finally {
    harness.restore()
  }
})

test('a LISTEN reconnect re-reads the user backlog from that connection watermark', async () => {
  const harness = installTransportStubs()
  try {
    harness.pushUserEvent(userEvent(10n))

    const hub = await buildHub()
    try {
      const recorder = createRecorder()
      const connection = await hub.addSseConnection(
        {
          kind: 'user',
          channelIds: [],
          organizationId: parseOrganizationId(randomUUID()),
          scopes: [],
          userId: parseUserId(randomUUID()),
        },
        recorder.sink,
      )
      assert.equal(recorder.frames().length, 1)

      harness.pushUserEvent(userEvent(11n))
      await harness.listenOptions()?.onListenRecovered?.()

      const frames = recorder.frames()
      assert.equal(frames.length, 2, 'the event published during the gap must be written')
      assert.ok(frames[1]?.includes('id: 11'))
      assert.equal(
        'lastEventId' in connection ? connection.lastEventId : -1n,
        11n,
        'and the watermark must move with it, exactly once',
      )
    } finally {
      await hub.close()
    }
  } finally {
    harness.restore()
  }
})

test('the re-read is skipped for a connection that is still hydrating', async () => {
  // Not an omission: the recovery hook runs after the LISTEN has been
  // re-issued, so a connection whose own backlog read has not finished yet is
  // guaranteed to read the log at or after the moment live delivery resumed.
  // Hydrating it a second time in parallel would write the same rows twice.
  const harness = installTransportStubs()
  try {
    const threadId = randomUUID()
    const hub = await buildHub()
    try {
      const recorder = createRecorder()
      const connection = await hub.addSseConnection(threadId, recorder.sink)
      if ('hydrating' in connection) {
        connection.hydrating = true
      }
      harness.pushThreadEvent(threadEvent(threadId, 1))

      await harness.listenOptions()?.onListenRecovered?.()

      assert.deepEqual(recorder.frames(), [], 'a hydrating connection is left to its own read')
      assert.equal(
        'hydrating' in connection ? connection.hydrating : false,
        true,
        'and is not taken out of hydration by somebody else',
      )
    } finally {
      await hub.close()
    }
  } finally {
    harness.restore()
  }
})

test('a truncated user replay writes a gap frame that carries no id', async () => {
  // Audit 2.9, from the hub's side: the cap must not be silent, and the marker
  // must not move the watermark it is warning about.
  const harness = installTransportStubs()
  try {
    harness.pushUserEvent(userEvent(7n))
    harness.truncateNextUserReplay(true)

    const hub = await buildHub()
    try {
      const recorder = createRecorder()
      await hub.addSseConnection(
        {
          kind: 'user',
          channelIds: [],
          organizationId: parseOrganizationId(randomUUID()),
          scopes: [],
          userId: parseUserId(randomUUID()),
        },
        recorder.sink,
      )

      const frames = recorder.frames()
      const gap = frames.at(-1)
      assert.ok(gap, 'a truncated replay must write something')
      assert.ok(gap.includes('event: realtime.gap'), `expected a gap frame, got ${gap}`)
      assert.ok(
        !gap.includes('id:'),
        'the gap frame must carry no id: it is a signal about the watermark, not an event',
      )
    } finally {
      await hub.close()
    }
  } finally {
    harness.restore()
  }
})
