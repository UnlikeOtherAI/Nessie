import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'

import { attachConsolidationDisclosureSources } from '../src/consolidation-disclosure-sources.js'

const CHANNEL = '22222222-2222-2222-2222-222222222222'
const AUTHOR = '11111111-1111-1111-1111-111111111111'

test('consolidation keeps raw-human authors, stored derived sources, and explicit unknowns apart', async () => {
  const messages = await attachConsolidationDisclosureSources(
    {
      query: async () => ({
        rows: [{
          messageId: 'derived',
          sourceAuthorUserId: AUTHOR,
          sourceChannelId: CHANNEL,
        }],
      }),
    } as Pick<Pool, 'query'>,
    {
      channelId: CHANNEL,
      channelVisibility: 'private',
      messages: [
        { agent_id: null, id: 'human', metadata: null, on_behalf_of_user_id: null, role: 'user', user_id: AUTHOR },
        { agent_id: 'agent', id: 'derived', metadata: null, on_behalf_of_user_id: null, role: 'assistant', user_id: null },
        { agent_id: null, id: 'delegated', metadata: { delegatedByAgentId: 'agent' }, on_behalf_of_user_id: null, role: 'user', user_id: AUTHOR },
      ],
    },
  )

  assert.deepEqual(messages.map((message) => message.privateConversationSources), [
    [{ sourceAuthorUserId: AUTHOR, sourceChannelId: CHANNEL }],
    [{ sourceAuthorUserId: AUTHOR, sourceChannelId: CHANNEL }],
    [{ sourceAuthorUserId: null, sourceChannelId: CHANNEL }],
  ])
})

test('public consolidation does not invent private source provenance', async () => {
  const messages = await attachConsolidationDisclosureSources(
    { query: async () => { throw new Error('public memories need no source lookup') } } as Pick<Pool, 'query'>,
    {
      channelId: CHANNEL,
      channelVisibility: 'public',
      messages: [{ agent_id: null, id: 'human', metadata: null, on_behalf_of_user_id: null, role: 'user', user_id: AUTHOR }],
    },
  )

  assert.equal(messages[0]?.privateConversationSources, undefined)
})
