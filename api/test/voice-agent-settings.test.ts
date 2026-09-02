import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_SPEAKING_STYLE_PRESETS,
  buildSpeakingStyleBlock,
  DEFAULT_VOICE_NAME,
  GEMINI_LIVE_VOICES,
} from '@nessie/schemas'

import {
  buildVoiceSystemInstruction,
  resolveVoiceName,
} from '../src/services/voice/voice-context.js'

/**
 * The two per-agent settings the Agent Designer writes, at the point where the
 * voice call reads them back.
 */

test('the agent’s own voice wins over the deployment default', () => {
  assert.equal(resolveVoiceName('Kore', { NESSIE_VOICE_GEMINI_VOICE: 'Puck' }), 'Kore')
})

test('an agent with no voice falls back to the deployment default', () => {
  assert.equal(resolveVoiceName(null, { NESSIE_VOICE_GEMINI_VOICE: 'Puck' }), 'Puck')
  assert.equal(resolveVoiceName(undefined, {}), DEFAULT_VOICE_NAME)
})

test('a name outside the curated list never reaches Gemini’s setup', () => {
  // Gemini closes the socket on an unknown `voiceName`, so an operator typo in
  // the deployment default would otherwise fail every call rather than one.
  assert.equal(resolveVoiceName('Nonesuch', { NESSIE_VOICE_GEMINI_VOICE: 'Kore' }), 'Kore')
  assert.equal(resolveVoiceName(null, { NESSIE_VOICE_GEMINI_VOICE: 'Typo' }), DEFAULT_VOICE_NAME)
  assert.ok(GEMINI_LIVE_VOICES.some((voice) => voice.name === DEFAULT_VOICE_NAME))
})

test('the speaking style reaches the call’s system instruction', () => {
  const style = AGENT_SPEAKING_STYLE_PRESETS[1].text
  const instruction = buildVoiceSystemInstruction({
    agentName: 'Ada',
    agentSpeakingStyle: style,
    agentSystemPrompt: null,
    toolNames: ['pa_send'],
    userDisplayName: 'Ondrej',
  })

  // Rendered by the one shared builder, so the spoken surface and the typed
  // system prompt cannot describe the same choice differently.
  assert.ok(instruction.includes(buildSpeakingStyleBlock(style) ?? ''))
})

test('a blank speaking style adds nothing at all', () => {
  assert.equal(buildSpeakingStyleBlock('   '), null)
  const instruction = buildVoiceSystemInstruction({
    agentName: 'Ada',
    agentSpeakingStyle: '   ',
    agentSystemPrompt: null,
    toolNames: ['pa_send'],
    userDisplayName: null,
  })
  assert.doesNotMatch(instruction, /How to talk to this person/u)
})
