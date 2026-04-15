import assert from 'node:assert/strict'
import test from 'node:test'

import type { WsScope } from '@nessie/schemas'
import { shouldDeliverWsNotification } from '../src/realtime/hub.js'
import { buildAccessibleChannelWhere } from '../src/services/agents.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const channelId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'

test('channel visibility filter allows public channels and explicit memberships', () => {
  assert.deepEqual(
    buildAccessibleChannelWhere({ organizationId, userId }),
    {
      organizationId,
      OR: [
        { visibility: 'public' },
        { members: { some: { userId } } },
      ],
    },
  )
})

test('owner channel visibility filter stays scoped to the organization', () => {
  assert.deepEqual(
    buildAccessibleChannelWhere({
      includeAllOrgChannels: true,
      organizationId,
      userId,
    }),
    { organizationId },
  )
})

test('channel-scoped websocket events require both subscription interest and channel access', async () => {
  const connectionScopes: WsScope[] = [
    { kind: 'organization', organizationId },
  ]
  const notificationScopes: WsScope[] = [
    { kind: 'organization', organizationId },
    { kind: 'channel', channelId },
  ]

  assert.equal(
    await shouldDeliverWsNotification({
      connectionScopes,
      notificationScopes,
      canAccessChannel: async () => false,
    }),
    false,
  )

  assert.equal(
    await shouldDeliverWsNotification({
      connectionScopes,
      notificationScopes,
      canAccessChannel: async () => true,
    }),
    true,
  )
})

test('channel-scoped websocket events do not deliver to unrelated subscriptions', async () => {
  assert.equal(
    await shouldDeliverWsNotification({
      connectionScopes: [
        { kind: 'agent', agentId: '00000000-0000-4000-8000-000000000004' },
      ],
      notificationScopes: [
        { kind: 'channel', channelId },
      ],
      canAccessChannel: async () => true,
    }),
    false,
  )
})

test('multi-channel websocket events require access to every channel scope', async () => {
  assert.equal(
    await shouldDeliverWsNotification({
      connectionScopes: [
        { kind: 'organization', organizationId },
      ],
      notificationScopes: [
        { kind: 'organization', organizationId },
        { kind: 'channel', channelId },
        { kind: 'channel', channelId: '00000000-0000-4000-8000-000000000005' },
      ],
      canAccessChannel: async (candidateChannelId) => candidateChannelId === channelId,
    }),
    false,
  )
})
