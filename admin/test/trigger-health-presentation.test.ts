import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getTriggerHealthMessage,
  getTriggerTone,
} from '../src/components/features/triggers/trigger-presentation.js'

// What a person reads when a schedule has stopped.
//
// The Triggers page could previously show that a trigger was in ERROR but never
// why: the cause lived only in the newest delivery row's `errorMessage`, which
// is how one production sweep stayed broken and unexplained for nineteen days.
// The reason is now a stable server code, and these are the sentences it turns
// into — plus the fallbacks, because an unknown code must still say something
// true rather than render blank.

test('a stopped schedule explains itself from its reason code', () => {
  const message = getTriggerHealthMessage({
    healthReason: 'uoa_identity_unverifiable',
    healthDetail: undefined,
  })
  assert.match(String(message), /can no longer prove the UnlikeOtherAI identity/)
  assert.match(String(message), /Reauthorize/)
})

test('each reason names its own remedy rather than one generic failure', () => {
  const channel = getTriggerHealthMessage({
    healthReason: 'channel_access_lost',
    healthDetail: undefined,
  })
  const member = getTriggerHealthMessage({
    healthReason: 'member_inactive',
    healthDetail: undefined,
  })
  assert.match(String(channel), /target channel/)
  assert.match(String(member), /no longer an active member/)
  assert.notEqual(channel, member)
})

test('an unrecognized reason falls back to the detail, then to a plain sentence', () => {
  assert.equal(
    getTriggerHealthMessage({
      healthReason: 'something_new_the_server_added',
      healthDetail: 'Scheduled task cannot run because of a newer check.',
    }),
    'Scheduled task cannot run because of a newer check.',
  )
  assert.equal(
    getTriggerHealthMessage({
      healthReason: 'something_new_the_server_added',
      healthDetail: undefined,
    }),
    'This schedule has stopped running.',
  )
})

test('a healthy schedule shows no failure banner', () => {
  assert.equal(
    getTriggerHealthMessage({ healthReason: undefined, healthDetail: undefined }),
    null,
  )
})

test('needs_reauthorization reads as recoverable, not as a hard error', () => {
  // Tone drives the status pill. Reauthorizing is a button away, so it is not
  // painted with the same finality as a broken target.
  assert.equal(getTriggerTone('needs_reauthorization'), 'warning')
  assert.equal(getTriggerTone('error'), 'danger')
  assert.equal(getTriggerTone('active'), 'success')
})
