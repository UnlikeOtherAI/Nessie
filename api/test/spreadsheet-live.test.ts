import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  NOTIFY_PAYLOAD_LIMIT_BYTES,
  buildDocumentEnvelope,
  buildSheetOpsEvent,
  type RealtimeNotificationPayload,
} from '@nessie/runtime'
import { DocumentSseEventSchema } from '@nessie/schemas'

import { createDocumentLane, type DocumentSseConnection } from '../src/realtime/document-lane.js'
import { createWsNotificationDelivery } from '../src/realtime/notification-delivery.js'

/**
 * The per-document live lane.
 *
 * Three things have to hold, and each has bitten this repository before:
 *
 * 1. A document event reaches only the connections on that page, and only
 *    while their read grant survives.
 * 2. An oversized `sheet.ops` arrives with `diffs: null` rather than being
 *    dropped in silence, so the client fetches that `seq` instead of sitting
 *    on a gap.
 * 3. **A replica running the previous build does not die on it.** During a
 *    blue-green swap that replica LISTENs on the same channel and hands the
 *    envelope to a fan-out that has never heard of `kind: 'document'`.
 */

type Recorder = DocumentSseConnection & { written: string[] }

const recorder = (input: {
  pageId: string
  userId?: string
  organizationId?: string
}): Recorder => {
  const written: string[] = []
  return {
    kind: 'document',
    pageId: input.pageId,
    spaceId: 'space',
    organizationId: input.organizationId ?? 'org',
    userId: input.userId ?? 'user',
    clientId: randomUUID(),
    saturated: false,
    written,
    response: {
      once: () => undefined,
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
    },
  } as Recorder
}

const documentNotification = (pageId: string, event: string, data: unknown) =>
  buildDocumentEnvelope({ pageId, organizationId: 'org', event, data })

test('a document event reaches its own page and nobody else', async () => {
  const lane = createDocumentLane({ canAccessKnowledgePage: async () => true })
  const mine = recorder({ pageId: 'page-a' })
  const theirs = recorder({ pageId: 'page-b' })
  lane.documentConnections.add(mine)
  lane.documentConnections.add(theirs)

  await lane.deliverDocumentNotification(
    documentNotification('page-a', 'sheet.presence.request', { pageId: 'page-a' }),
  )

  assert.equal(mine.written.length, 1)
  assert.match(mine.written[0] as string, /^event: sheet\.presence\.request\ndata: /)
  assert.equal(theirs.written.length, 0)
})

test('a reader who lost the page stops receiving within the entitlement window', async () => {
  let allowed = true
  let clock = 0
  const lane = createDocumentLane({
    canAccessKnowledgePage: async () => allowed,
    now: () => clock,
  })
  const connection = recorder({ pageId: 'page-a' })
  lane.documentConnections.add(connection)

  const send = () =>
    lane.deliverDocumentNotification(
      documentNotification('page-a', 'sheet.presence.request', { pageId: 'page-a' }),
    )

  await send()
  assert.equal(connection.written.length, 1)

  allowed = false
  await send()
  assert.equal(connection.written.length, 2, 'the memo still holds the old answer')

  // Past the TTL the question is asked again, and the stream stops.
  clock += 5_001
  await send()
  assert.equal(connection.written.length, 2, 'a revoked reader is cut off, not left running')
})

test('a hub with no entitlement predicate delivers nothing at all', async () => {
  // Fails closed. Unlike the ws lanes there is no declared-scope match to fall
  // back on, and a `pageId` is an opaque id rather than a grant.
  const lane = createDocumentLane({})
  const connection = recorder({ pageId: 'page-a' })
  lane.documentConnections.add(connection)
  await lane.deliverDocumentNotification(
    documentNotification('page-a', 'sheet.presence.request', { pageId: 'page-a' }),
  )
  assert.equal(connection.written.length, 0)
})

test('a saturated socket drops rather than queues', async () => {
  const lane = createDocumentLane({ canAccessKnowledgePage: async () => true })
  const connection = recorder({ pageId: 'page-a' })
  connection.saturated = true
  lane.documentConnections.add(connection)
  await lane.deliverDocumentNotification(
    documentNotification('page-a', 'sheet.presence.request', { pageId: 'page-a' }),
  )
  assert.equal(
    connection.written.length,
    0,
    'ephemeral events carry no sequence, so holding them buys nothing a re-read does not',
  )
})

test('a malformed document envelope from another replica is dropped, not thrown on', async () => {
  const lane = createDocumentLane({ canAccessKnowledgePage: async () => true })
  const connection = recorder({ pageId: 'page-a' })
  lane.documentConnections.add(connection)

  // A publisher ahead of this build, or a corrupted payload. The fan-out runs
  // in an unawaited promise, so a TypeError here is an unhandled rejection —
  // which ends the process on Node 22.
  for (const payload of [
    { kind: 'document', scopes: [] },
    { kind: 'document', document: null, scopes: [] },
    { kind: 'document', document: { event: 'sheet.ops' }, scopes: [] },
  ]) {
    await lane.deliverDocumentNotification(payload as never)
  }
  assert.equal(connection.written.length, 0)
})

test('an oversized sheet.ops arrives with diffs: null instead of vanishing', () => {
  const small = buildSheetOpsEvent({
    pageId: randomUUID(),
    organizationId: randomUUID(),
    batch: { seq: 1, diffs: Buffer.alloc(40).toString('base64') },
  })
  assert.equal(small.inlined, true)
  assert.notEqual(
    (small.envelope.document.data as { diffs: string | null }).diffs,
    null,
    'a single-cell edit is ~50 bytes and rides inline',
  )

  const huge = buildSheetOpsEvent({
    pageId: randomUUID(),
    organizationId: randomUUID(),
    batch: { seq: 2, diffs: Buffer.alloc(NOTIFY_PAYLOAD_LIMIT_BYTES).toString('base64') },
  })
  assert.equal(huge.inlined, false)
  assert.equal((huge.envelope.document.data as { diffs: string | null }).diffs, null)
  assert.ok(
    Buffer.byteLength(JSON.stringify(huge.envelope), 'utf8') <= NOTIFY_PAYLOAD_LIMIT_BYTES,
    'the compact form must itself fit, or the whole event is dropped in silence',
  )
})

test('every document envelope carries the previous-build compatibility shim', () => {
  const envelope = buildDocumentEnvelope({
    pageId: randomUUID(),
    organizationId: randomUUID(),
    event: 'sheet.presence',
    data: {},
  })
  // Everything the lane carries lives under `document`, a key the previous
  // build never reads, and `scopes` is present and empty so the WebSocket loop
  // it does reach filters an empty array and matches nobody.
  assert.deepEqual(envelope.scopes, [])
  assert.equal('eventId' in envelope, false)
  assert.equal('message' in envelope, false)
  assert.ok(envelope.document)
})

/**
 * The previous build's fan-out, transcribed from the shape it actually has:
 * read `kind` (not `'sse'`, so fall through), read `eventId` (absent, so build
 * no replay event and never dereference `message`), then `scopes.filter` for
 * every WebSocket connection — in an unawaited promise, where a TypeError is
 * an unhandled rejection that ends the process on Node 22.
 */
const previousBuildFanOut = (notification: RealtimeNotificationPayload): string => {
  const payload = notification as unknown as {
    kind: string
    eventId?: string
    message?: { event: string }
    scopes: { kind: string }[]
  }
  if (payload.kind === 'sse') return 'sse'
  if (typeof payload.eventId === 'string') {
    // The line that would throw if `document` were flattened to the top level
    // and `message` were absent: it is reached only when `eventId` is a string.
    return payload.message!.event
  }
  // The WebSocket loop, whose first act is a filter on `scopes`.
  const channels = payload.scopes.filter((scope) => scope.kind === 'channel')
  return `delivered:${channels.length}`
}

test('a replica on the previous build reads the document envelope and stays up', () => {
  for (const envelope of [
    buildDocumentEnvelope({
      pageId: randomUUID(),
      organizationId: randomUUID(),
      event: 'sheet.presence',
      data: { clientId: 'c1' },
    }),
    buildSheetOpsEvent({
      pageId: randomUUID(),
      organizationId: randomUUID(),
      batch: { seq: 9, diffs: null },
    }).envelope,
  ]) {
    // No throw, and nobody is sent anything — which is exactly right: that
    // build has no document connections to deliver to.
    assert.equal(previousBuildFanOut(envelope), 'delivered:0')
  }
})

test('this build`s own fan-out answers the document branch before the message guard', async () => {
  const delivery = createWsNotificationDelivery({
    entitlements: { canAccessKnowledgePage: async () => true },
  })
  const connection = recorder({ pageId: 'page-a' })
  delivery.documentConnections.add(connection as never)

  await delivery.deliverNotification(
    documentNotification('page-a', 'sheet.presence.request', { pageId: 'page-a' }) as never,
  )
  assert.equal(
    connection.written.length,
    1,
    'the branch has to come before the `message` guard, which would otherwise drop it',
  )
})

test('an event name this build has never heard of is refused at the publish door', () => {
  // The admin's reader validates every frame against the same union; refusing
  // here means an unparseable frame never reaches an open pane at all.
  assert.throws(() =>
    DocumentSseEventSchema.parse({ event: 'sheet.explodes', data: {} }),
  )
  assert.doesNotThrow(() =>
    DocumentSseEventSchema.parse({
      event: 'sheet.closed',
      data: { pageId: randomUUID(), reason: 'engine-migrating' },
    }),
  )
})
