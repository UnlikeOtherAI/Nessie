import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendBoundedVoiceFrame,
  VOICE_DICTATION_MAX_SAMPLES,
  voiceDictationBlocksSubmit,
} from '../src/components/features/channels/voice-dictation-state.js'

test('dictation blocks every submission path while recording or transcribing', () => {
  assert.equal(voiceDictationBlocksSubmit('idle'), false)
  assert.equal(voiceDictationBlocksSubmit('error'), false)
  assert.equal(voiceDictationBlocksSubmit('requestingPermission'), true)
  assert.equal(voiceDictationBlocksSubmit('recording'), true)
  assert.equal(voiceDictationBlocksSubmit('transcribing'), true)
})

test('the PCM sample cap accepts only the fixed 55-second prefix', () => {
  const finalFrame = appendBoundedVoiceFrame(
    new Int16Array([1, 2, 3, 4]),
    VOICE_DICTATION_MAX_SAMPLES - 2,
  )
  assert.deepEqual(Array.from(finalFrame.frame ?? []), [1, 2])
  assert.equal(finalFrame.collectedSamples, VOICE_DICTATION_MAX_SAMPLES)
  assert.equal(finalFrame.reachedCap, true)

  const afterCap = appendBoundedVoiceFrame(new Int16Array([1]), VOICE_DICTATION_MAX_SAMPLES)
  assert.equal(afterCap.frame, null)
  assert.equal(afterCap.reachedCap, true)
})
