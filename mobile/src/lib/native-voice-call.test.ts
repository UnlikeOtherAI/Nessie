import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isVoiceCallControlMessage,
  isVoiceCallStartMessage,
  nativeVoiceCallStateScript,
  NATIVE_VOICE_CALL_STATE_EVENT,
} from './native-voice-call'

const provisioning = {
  agentName: 'Personal Assistant',
  apiBaseUrl: 'https://api.nessie.works',
  installationId: '8f2e6d9a-1c3b-4a5e-9f70-2b6c8d1e4a30',
  refreshAfter: '2026-09-03T11:30:00.000Z',
  token: 'nvc1_abc',
  tokenExpiresAt: '2026-09-03T12:00:00.000Z',
}

test('a complete provisioning payload is accepted', () => {
  assert.equal(
    isVoiceCallStartMessage({ type: 'nessie:voice-call-start', voiceCall: provisioning }),
    true,
  )
})

test('a start message missing the API origin is refused', () => {
  // The admin is served from `app.` and the API from `api.`; the native side
  // has no relative base to resolve a path against, so a payload without one
  // would produce a call that fails at its first request rather than here.
  const withoutOrigin: Record<string, unknown> = { ...provisioning }
  delete withoutOrigin['apiBaseUrl']
  assert.equal(
    isVoiceCallStartMessage({ type: 'nessie:voice-call-start', voiceCall: withoutOrigin }),
    false,
  )
})

test('a start message with no payload at all is refused', () => {
  assert.equal(isVoiceCallStartMessage({ type: 'nessie:voice-call-start' }), false)
  assert.equal(
    isVoiceCallStartMessage({ type: 'nessie:voice-call-start', voiceCall: null }),
    false,
  )
})

test('another bridge message is not a call', () => {
  assert.equal(isVoiceCallStartMessage({ type: 'nessie:haptic', haptic: 'light' }), false)
  assert.equal(isVoiceCallControlMessage({ type: 'nessie:haptic' }), false)
})

test('both in-call controls are recognised', () => {
  assert.equal(isVoiceCallControlMessage({ type: 'nessie:voice-call-end' }), true)
  assert.equal(isVoiceCallControlMessage({ type: 'nessie:voice-call-mute', muted: true }), true)
})

test('the state script writes the global and fires the event', () => {
  const state = {
    agentName: 'Personal Assistant',
    assistantSpeaking: false,
    error: null,
    liveAssistantText: '',
    muted: false,
    phase: 'live' as const,
    startedAt: 1_756_900_000_000,
  }
  const script = nativeVoiceCallStateScript(state)

  // The global is what a reloaded page reads before it can subscribe; the
  // event is what a mounted page reacts to. Both, or a reload renders blind.
  assert.match(script, /window\.__nessieNativeVoiceCallState = /u)
  assert.ok(script.includes(NATIVE_VOICE_CALL_STATE_EVENT))
  assert.ok(script.includes('"phase":"live"'))
})
