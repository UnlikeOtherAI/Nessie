import { createHmac } from 'node:crypto'

import {
  LedgerVoiceError,
  isLedgerConfigured,
  postLedgerJson,
  type LedgerVoiceCallInput,
} from './ledger-client.js'

export { LedgerVoiceError } from './ledger-client.js'

/**
 * The Ledger side of a voice call: minting Google's one-use Gemini Live
 * credential, and relaying each turn's usage back.
 *
 * Coder's iOS app calls these Ledger endpoints directly with a per-user proxy
 * token. Nessie cannot: `LEDGER_PROXY_TOKEN` is the one deployment-wide,
 * product-bound app key and never leaves the server (`AGENTS.md`). So the API
 * brokers instead — it holds the app key, signs the caller's identity, and
 * hands the client only Google's ephemeral credential.
 */

/**
 * Whether this deployment is wired to Ledger at all.
 *
 * Configuration only — it says nothing about whether the key carries the
 * Gemini Live grants, which only Ledger can answer. A deployment with no
 * Ledger at all cannot call, and should not offer the control.
 */
export const isVoiceConfigured = isLedgerConfigured

export type LedgerVoiceCredential = {
  sessionId: string
  accessToken: string
  model: string
  expiresAt: string
  newSessionExpiresAt: string
  websocketUrl: string
}

type LedgerCallInput = LedgerVoiceCallInput

/**
 * The device identifier Ledger sees.
 *
 * Ledger keys its per-device credential slots (and their daily-budget
 * reservations) on this value, so it must be stable per installation and
 * unguessable. Hashing the installation id with the auth secret means the raw
 * row id never leaves the deployment and two deployments cannot collide.
 *
 * Formatted as a UUID because Ledger's contract requires one — it expects an
 * app-generated Keychain UUID. The digest is truncated to 16 bytes and stamped
 * with version 8 (RFC 9562's "custom" version, which is exactly what a derived
 * identifier is) plus the standard variant bits.
 */
export const ledgerDeviceId = (installationId: string, authSecret: string): string => {
  const digest = createHmac('sha256', authSecret)
    .update(`voice-installation:${installationId}`)
    .digest()
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

const parseCredential = (payload: unknown, fallbackWebsocketUrl: string): LedgerVoiceCredential => {
  const body = (payload ?? {}) as Record<string, unknown>
  const sessionId = body['sessionId']
  const accessToken = body['accessToken']
  const model = body['model']
  const expiresAt = body['expiresAt']
  const newSessionExpiresAt = body['newSessionExpiresAt']
  if (
    typeof sessionId !== 'string'
    || typeof accessToken !== 'string'
    || typeof model !== 'string'
    || typeof expiresAt !== 'string'
    || typeof newSessionExpiresAt !== 'string'
    || sessionId.length === 0
    || accessToken.length === 0
  ) {
    throw new LedgerVoiceError(
      'VOICE_LEDGER_RESPONSE_INVALID',
      'Ledger returned an invalid Gemini Live credential.',
    )
  }
  const websocketUrl = body['websocketUrl']
  return {
    sessionId,
    accessToken,
    model,
    expiresAt,
    newSessionExpiresAt,
    websocketUrl:
      typeof websocketUrl === 'string' && websocketUrl.length > 0
        ? websocketUrl
        : fallbackWebsocketUrl,
  }
}

/**
 * The Gemini Live endpoint used when Ledger does not name one.
 *
 * The *constrained* service is the one an ephemeral credential may open —
 * which is exactly why a browser or phone can hold that credential safely.
 */
export const DEFAULT_GEMINI_LIVE_WEBSOCKET_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'

/** Mints one credential. Also used for rotation — Ledger supersedes the slot. */
export const mintVoiceCredential = async (
  input: LedgerCallInput & { deviceId: string },
): Promise<LedgerVoiceCredential> => {
  const payload = await postLedgerJson<unknown>({
    ...input,
    path: '/v1/gemini/live-token',
    body: { deviceId: input.deviceId },
    systemComponent: 'voice-call',
    acceptedStatuses: [402, 403, 429],
  })
  return parseCredential(payload, DEFAULT_GEMINI_LIVE_WEBSOCKET_URL)
}

export type LedgerUsageRelayInput = LedgerCallInput & {
  ledgerSessionId: string
  sequence: number
  model: string
  usage: Record<string, unknown> | null
  complete: boolean
}

export type LedgerUsageRelayResult = {
  acceptedSequence: number
  duplicate: boolean
  complete: boolean
}

/**
 * Relays one turn's usage.
 *
 * The client's sequence number is preserved end to end: Ledger derives its
 * idempotency key from `(sessionId, sequence)`, so a retried report is
 * recognised rather than double-counted, and a stale one is refused.
 */
export const relayVoiceUsage = async (
  input: LedgerUsageRelayInput,
): Promise<LedgerUsageRelayResult> => {
  const path = `/v1/gemini/live-sessions/${encodeURIComponent(input.ledgerSessionId)}/usage`
  const body = await postLedgerJson<Record<string, unknown>>({
    ...input,
    path,
    body: {
      sequence: input.sequence,
      model: input.model,
      usage: input.usage,
      ...(input.complete ? { complete: true } : {}),
    },
    idempotencyKey: `${input.ledgerSessionId}:${input.sequence}`,
    systemComponent: 'voice-call',
    acceptedStatuses: [409],
  })
  return {
    acceptedSequence:
      typeof body['acceptedSequence'] === 'number' ? body['acceptedSequence'] : input.sequence,
    duplicate: body['duplicate'] === true,
    complete: body['complete'] === true,
  }
}
