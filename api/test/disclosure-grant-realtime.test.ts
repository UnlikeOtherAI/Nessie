import assert from 'node:assert/strict'
import test from 'node:test'

import { publishMessageDisclosureChanged } from '../src/services/disclosure-grant-realtime.js'

const MESSAGE = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '33333333-3333-4333-8333-333333333333'
const ORGANIZATION = '44444444-4444-4444-8444-444444444444'

test('a disclosure grant announces only identifiers on the message channel scope', async () => {
  let scopeInput: unknown = null
  let published: unknown = null
  await publishMessageDisclosureChanged({
    buildChannelRealtimeScopes: (input) => {
      scopeInput = input
      return [{ channelId: input.channelId, kind: 'channel' }]
    },
    messageId: MESSAGE,
    prisma: {
      message: {
        findUnique: async () => ({
          thread: {
            channel: {
              id: CHANNEL,
              organizationId: ORGANIZATION,
              systemChannelType: null,
              visibility: 'public',
            },
            id: THREAD,
          },
        }),
      },
    } as never,
    realtimeHub: {
      publishWs: async (scopes, input) => {
        published = { input, scopes }
      },
    } as never,
  })

  assert.deepEqual(scopeInput, {
    channelId: CHANNEL,
    organizationId: ORGANIZATION,
    systemChannelType: null,
    visibility: 'public',
  })
  assert.deepEqual(published, {
    input: {
      data: { messageId: MESSAGE, threadId: THREAD },
      event: 'message.disclosure.changed',
    },
    scopes: [{ channelId: CHANNEL, kind: 'channel' }],
  })
})

test('a missing shared reply produces no notification', async () => {
  let published = false
  await publishMessageDisclosureChanged({
    buildChannelRealtimeScopes: () => [],
    messageId: MESSAGE,
    prisma: { message: { findUnique: async () => null } } as never,
    realtimeHub: { publishWs: async () => { published = true } } as never,
  })
  assert.equal(published, false)
})
