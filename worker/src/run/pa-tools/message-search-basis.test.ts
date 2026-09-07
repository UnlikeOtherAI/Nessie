import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { recordMessageChannelRead, recordPrivateConversationMessageRead } from './message-search-basis.js'

test('a private or protected source channel becomes run provenance', () => {
  const sink = createConsumedSourceSink()
  recordMessageChannelRead({ consumedSources: sink }, [
    { id: 'channel-private', visibility: 'private' },
    { id: 'channel-protected', visibility: 'protected' },
  ])

  assert.deepEqual(sink.list(), [
    { scopeId: 'channel-private', scopeType: 'channel' },
    { scopeId: 'channel-protected', scopeType: 'channel' },
  ])
})

test('a public source channel is deliberately not recorded', () => {
  // A viewer's channel scopes come from their ChannelMember rows alone, so a
  // public channel someone can read but has not joined gives them no scope.
  // Recording it would withhold the reply from people entitled to read the
  // source — over-restriction, and untrue: org-readable material is not
  // privileged.
  const sink = createConsumedSourceSink()
  recordMessageChannelRead({ consumedSources: sink }, [
    { id: 'channel-public', visibility: 'public' },
  ])

  assert.deepEqual(sink.list(), [])
})

test('a mixed page of results records only the channels that are actually scoped', () => {
  const sink = createConsumedSourceSink()
  recordMessageChannelRead({ consumedSources: sink }, [
    { id: 'channel-public', visibility: 'public' },
    { id: 'channel-private', visibility: 'private' },
    { id: 'channel-public-2', visibility: 'public' },
  ])

  assert.deepEqual(sink.list(), [{ scopeId: 'channel-private', scopeType: 'channel' }])
})

test('the same channel appearing in several hits is recorded once', () => {
  const sink = createConsumedSourceSink()
  recordMessageChannelRead({ consumedSources: sink }, [
    { id: 'channel-private', visibility: 'private' },
    { id: 'channel-private', visibility: 'private' },
  ])

  assert.equal(sink.size(), 1)
})

test('a run with no sink is a no-op rather than a crash', () => {
  // Sub-agent and utility tool contexts carry no sink; they materialise no
  // message of their own, so there is nothing to stamp.
  assert.doesNotThrow(() =>
    recordMessageChannelRead({ consumedSources: undefined }, [
      { id: 'channel-private', visibility: 'private' },
    ]),
  )
})

test('a legacy private search result remains unknown beside a known author in the same room', () => {
  const sink = createConsumedSourceSink()
  recordPrivateConversationMessageRead({ consumedSources: sink }, [
    {
      agentId: null, channelId: 'channel-private', channelVisibility: 'private', metadata: null,
      disclosureSources: [], onBehalfOfUserId: null, role: 'user', userId: 'author-b',
    },
    {
      agentId: null, channelId: 'channel-private', channelVisibility: 'private', metadata: null,
      disclosureSources: [], onBehalfOfUserId: null, role: 'assistant', userId: null,
    },
  ])

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'channel-private' },
    { sourceAuthorUserId: null, sourceChannelId: 'channel-private' },
  ])
})

test('a delegated legacy user-shaped result remains unknown', () => {
  const sink = createConsumedSourceSink()
  recordPrivateConversationMessageRead({ consumedSources: sink }, [{
    agentId: null,
    channelId: 'channel-private',
    channelVisibility: 'private',
    disclosureSources: [],
    metadata: { delegatedByAgentId: 'agent-1' },
    onBehalfOfUserId: null,
    role: 'user',
    userId: 'author-b',
  }])

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: null, sourceChannelId: 'channel-private' },
  ])
})

test('a derived private search result retains its persisted original author', () => {
  const sink = createConsumedSourceSink()
  recordPrivateConversationMessageRead({ consumedSources: sink }, [{
    agentId: 'agent-1',
    channelId: 'channel-private',
    channelVisibility: 'private',
    disclosureSources: [{ sourceAuthorUserId: 'author-b', sourceChannelId: 'channel-private' }],
    metadata: null,
    onBehalfOfUserId: 'author-b',
    role: 'assistant',
    userId: null,
  }])

  assert.deepEqual(sink.privateConversationSources(), [
    { sourceAuthorUserId: 'author-b', sourceChannelId: 'channel-private' },
  ])
})
