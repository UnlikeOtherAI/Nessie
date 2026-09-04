import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasEmailAccountConnectCard,
  readEmailAccountConnectScope,
} from '../src/components/features/channels/EmailAccountConnectCard.js'

test('only the dedicated email-account connect card opens the secure form', () => {
  assert.equal(
    hasEmailAccountConnectCard({ card: { kind: 'email_account_connect' } }),
    true,
  )
  assert.equal(hasEmailAccountConnectCard({ card: { kind: 'comms_connect' } }), false)
  assert.equal(hasEmailAccountConnectCard({ card: 'email_account_connect' }), false)
  assert.equal(hasEmailAccountConnectCard(undefined), false)
})

test('the card defaults to personal scope and preserves an explicit team scope', () => {
  assert.equal(
    readEmailAccountConnectScope({ card: { kind: 'email_account_connect' } }),
    'user',
  )
  assert.equal(
    readEmailAccountConnectScope({
      card: { kind: 'email_account_connect', scope: 'team' },
    }),
    'team',
  )
  assert.equal(readEmailAccountConnectScope({ card: { kind: 'other' } }), null)
})
