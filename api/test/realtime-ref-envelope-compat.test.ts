import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSseRefEnvelope, buildWsRefEnvelope } from '@nessie/runtime'
import { parseChannelId, parseOrganizationId, type WsScope } from '@nessie/schemas'

import { shouldDeliverWsNotification } from '../src/realtime/notification-delivery.js'

const organizationId = parseOrganizationId('00000000-0000-4000-8000-000000000001')
const channelId = parseChannelId('00000000-0000-4000-8000-000000000002')

const deliveryScopes: WsScope[] = [
  { kind: 'organization', organizationId },
  { kind: 'channel', channelId },
]

const allow = async () => true

/**
 * A compact ref envelope is published by a replica running *this* build and
 * received by one running the previous build, for the whole length of a
 * blue-green swap. That build does not recognise `sse-ref`/`ws-ref`, so it
 * takes its WebSocket path — no `kind` match, no top-level `eventId`, therefore
 * no replay event — and lands in the per-connection loop, whose first act is to
 * read the notification's `scopes`. The envelopes carry an empty array there
 * precisely so that read finds an array and matches nothing.
 *
 * This is the assertion that keeps the empty array honest: whatever a ref
 * envelope's `scopes` is, feeding it to the scope test must decide *no* for
 * every connection, and must not throw doing it. The event is not lost — the
 * row is committed and the client's next reconnect replays it.
 */
test('a ref envelope delivers to no connection and does not throw', async () => {
  const envelopes = [
    buildSseRefEnvelope({ sequence: 4242, threadId: '00000000-0000-4000-8000-000000000003' }),
    buildWsRefEnvelope({ eventId: '99', scopes: deliveryScopes }),
  ]

  for (const envelope of envelopes) {
    const rawScopes: unknown = (envelope as { scopes?: unknown }).scopes
    assert.ok(
      Array.isArray(rawScopes),
      `${envelope.kind}: the previous build reads \`scopes\` unchecked, so it must be an array`,
    )
    const notificationScopes = rawScopes as WsScope[]
    assert.equal(notificationScopes.length, 0, `${envelope.kind}: that array must be empty`)

    // Every connection shape the loop can hold, including one subscribed to the
    // very scopes the ws-ref envelope really targets.
    for (const connectionScopes of [[], deliveryScopes]) {
      const delivered = await shouldDeliverWsNotification({
        canAccessAgent: allow,
        canAccessChannel: allow,
        canAccessDashboard: allow,
        canAccessOrganization: allow,
        connectionScopes,
        notificationScopes,
      })
      assert.equal(
        delivered,
        false,
        `${envelope.kind}: an envelope the listener cannot read must reach nobody`,
      )
    }
  }
})

/**
 * The same guard from this side of the deploy. A publisher *ahead* of this
 * build can put a shape on the wire whose `scopes` is missing or not an array,
 * and the fan-out runs in an unawaited promise — so dereferencing it unchecked
 * is not a caught error but an unhandled rejection, which ends the process on
 * Node 22. That is exactly the failure the empty array exists to spare the
 * previous build; this build must not be able to suffer it either.
 */
test('a notification whose scopes are missing or malformed reaches nobody instead of throwing', async () => {
  for (const notificationScopes of [undefined, null, 'channel', { kind: 'channel' }]) {
    const delivered = await shouldDeliverWsNotification({
      canAccessAgent: allow,
      canAccessChannel: allow,
      canAccessDashboard: allow,
      canAccessOrganization: allow,
      connectionScopes: deliveryScopes,
      notificationScopes: notificationScopes as unknown as WsScope[],
    })
    assert.equal(delivered, false, `scopes ${JSON.stringify(notificationScopes)} must reach nobody`)
  }
})
