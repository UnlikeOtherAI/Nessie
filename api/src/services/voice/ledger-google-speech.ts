import { safeFetch, type LedgerIdentityService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { LedgerVoiceError, isLedgerConfigured, postLedgerJson } from './ledger-client.js'

export const isVoiceDictationConfigured = isLedgerConfigured
// Ledger permits up to 10 seconds for OAuth, 20 seconds for recognition, and
// a small durable-settlement margin. Do not use the generic 15-second voice
// broker timeout: a late settled transcript is intentionally not recoverable.
export const VOICE_DICTATION_LEDGER_TIMEOUT_MS = 45_000

export const transcribeVoiceDictation = async (input: {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService | null
  audioBase64: string
  idempotencyKey: string
  locale?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof safeFetch
  timeoutSignalFactory?: (timeoutMs: number) => AbortSignal
}): Promise<string> => {
  const body = await postLedgerJson<Record<string, unknown>>({
    actorContext: input.actorContext,
    ledgerIdentity: input.ledgerIdentity,
    env: input.env,
    fetchImpl: input.fetchImpl,
    timeoutSignalFactory: input.timeoutSignalFactory,
    path: '/v1/google-speech/transcriptions',
    body: { audioBase64: input.audioBase64, idempotencyKey: input.idempotencyKey, locale: input.locale },
    idempotencyKey: input.idempotencyKey,
    systemComponent: 'voice-transcription',
    acceptedStatuses: [402, 403, 409, 429],
    timeoutMs: VOICE_DICTATION_LEDGER_TIMEOUT_MS,
  })
  if (typeof body['transcript'] !== 'string') {
    throw new LedgerVoiceError('VOICE_LEDGER_RESPONSE_INVALID', 'Ledger returned an invalid transcription.')
  }
  return body['transcript']
}
