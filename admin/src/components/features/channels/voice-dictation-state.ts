export const VOICE_DICTATION_MAX_RECORDING_MS = 55_000
export const VOICE_DICTATION_SAMPLE_RATE = 16_000
export const VOICE_DICTATION_MAX_SAMPLES =
  (VOICE_DICTATION_MAX_RECORDING_MS / 1_000) * VOICE_DICTATION_SAMPLE_RATE

export type VoiceDictationState =
  | 'idle'
  | 'requestingPermission'
  | 'recording'
  | 'transcribing'
  | 'error'

export const voiceDictationBlocksSubmit = (state: VoiceDictationState) =>
  state !== 'idle' && state !== 'error'

/** Accept only the fixed-duration prefix of one worklet frame. This is the
 * hard bound; the wall-clock timeout is only a convenience for active tabs. */
export const appendBoundedVoiceFrame = (frame: Int16Array, collectedSamples: number) => {
  const remaining = VOICE_DICTATION_MAX_SAMPLES - collectedSamples
  if (remaining <= 0) {
    return { frame: null, collectedSamples, reachedCap: true }
  }
  const accepted = frame.length > remaining ? frame.slice(0, remaining) : frame
  const next = collectedSamples + accepted.length
  return { frame: accepted, collectedSamples: next, reachedCap: next >= VOICE_DICTATION_MAX_SAMPLES }
}
