import assert from 'node:assert/strict'
import test from 'node:test'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { localInferenceRecipientIsAuthorized } from './local-inference-recipient.js'

const sourceSink = () => {
  const consumedSources = createConsumedSourceSink()
  consumedSources.add({ scopeId: 'channel-1', scopeType: 'channel' })
  consumedSources.addPrivateConversationSource({
    sourceAuthorUserId: 'owner-1',
    sourceChannelId: 'channel-1',
  })
  return consumedSources
}

test('a local recipient needs the whole consumed basis and its own private lineage', () => {
  const authorized = () => localInferenceRecipientIsAuthorized({
    context: { consumedSources: sourceSink() },
    ownerUserId: 'owner-1',
    viewer: {
      kind: 'user',
      scopes: [{ scopeId: 'channel-1', scopeType: 'channel' }],
      userId: 'owner-1',
    },
  })
  assert.equal(authorized(), true)

  assert.equal(localInferenceRecipientIsAuthorized({
    context: { consumedSources: sourceSink() },
    ownerUserId: 'owner-1',
    viewer: { kind: 'user', scopes: [], userId: 'owner-1' },
  }), false)

  const unknownLineage = sourceSink()
  unknownLineage.addPrivateConversationSource({
    sourceAuthorUserId: null,
    sourceChannelId: 'channel-1',
  })
  assert.equal(localInferenceRecipientIsAuthorized({
    context: { consumedSources: unknownLineage },
    ownerUserId: 'owner-1',
    viewer: {
      kind: 'user',
      scopes: [{ scopeId: 'channel-1', scopeType: 'channel' }],
      userId: 'owner-1',
    },
  }), false)
})
