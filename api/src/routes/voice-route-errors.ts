import { sendApiError } from '../lib/api.js'
import { LedgerVoiceError } from '../services/voice/ledger-gemini-live.js'
import { VoiceSessionError } from '../services/voice/voice-session.js'

/**
 * Maps a voice service refusal onto its response.
 *
 * Both error types already carry the status and code the caller should see —
 * a device that is not yours, a call that has ended, a Ledger that refused —
 * so the route layer only has to recognise them. Anything else is a genuine
 * fault and keeps bubbling, rather than being flattened into a tidy 4xx that
 * would hide it.
 */
export const sendVoiceError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): ReturnType<typeof sendApiError> | null => {
  if (error instanceof VoiceSessionError || error instanceof LedgerVoiceError) {
    return sendApiError(reply, error.status, error.code, error.message)
  }
  return null
}
