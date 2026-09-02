import { createHmac } from 'node:crypto'

import {
  attributionFromActorContext,
  safeFetch,
  type LedgerIdentityService,
} from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

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

const LIVE_TOKEN_PATH = '/v1/gemini/live-token'
const LEDGER_TIMEOUT_MS = 15_000

/** Only these identity headers may reach Ledger; anything else is a defect. */
const ALLOWED_IDENTITY_HEADERS = new Set(['x-nessie-context', 'x-uoa-delegation'])

/**
 * Whether this deployment is wired to Ledger at all.
 *
 * Configuration only — it says nothing about whether the key carries the
 * Gemini Live grants, which only Ledger can answer. A deployment with no
 * Ledger at all cannot call, and should not offer the control.
 */
export const isVoiceConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env['LEDGER_PUBLIC_URL']?.trim() && env['LEDGER_PROXY_TOKEN']?.trim())

export class LedgerVoiceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'LedgerVoiceError'
    this.code = code
    this.status = status
  }
}

export type LedgerVoiceCredential = {
  sessionId: string
  accessToken: string
  model: string
  expiresAt: string
  newSessionExpiresAt: string
  websocketUrl: string
}

type LedgerCallInput = {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService | null
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof safeFetch
}

const readLedgerConfig = (env: NodeJS.ProcessEnv) => {
  const baseUrl = env['LEDGER_PUBLIC_URL']?.trim()
  const proxyToken = env['LEDGER_PROXY_TOKEN']?.trim()
  if (!baseUrl || !proxyToken) {
    throw new LedgerVoiceError(
      'VOICE_LEDGER_UNCONFIGURED',
      'Voice calling requires LEDGER_PUBLIC_URL and LEDGER_PROXY_TOKEN.',
      503,
    )
  }
  let origin: string
  try {
    // Only the origin is used: a configured path would otherwise be prepended
    // to the endpoint and silently produce a 404. Same rule as `web_search`.
    origin = new URL(baseUrl).origin
  } catch {
    throw new LedgerVoiceError(
      'VOICE_LEDGER_UNCONFIGURED',
      'LEDGER_PUBLIC_URL is not a valid URL.',
      503,
    )
  }
  return { origin, proxyToken }
}

/**
 * Builds the headers for one Ledger call.
 *
 * Signing follows the deployment-wide rule for every Ledger call: when a
 * signer is configured the identity is mandatory and a user with no linked UOA
 * identity fails closed; with no signer configured at all the app key travels
 * alone and Ledger decides whether that token needs provenance.
 */
const buildLedgerHeaders = async (input: LedgerCallInput, proxyToken: string) => {
  const headers = new Headers({
    Authorization: `Bearer ${proxyToken}`,
    'Content-Type': 'application/json',
  })

  if (!input.ledgerIdentity) return headers

  const attribution = attributionFromActorContext(input.actorContext, {
    systemComponent: 'voice-call',
  })
  const identityHeaders = await input.ledgerIdentity.requestHeaders(attribution, {
    requireUoaIdentity: true,
  })
  for (const [name, value] of Object.entries(identityHeaders)) {
    if (!ALLOWED_IDENTITY_HEADERS.has(name.toLowerCase()) || !value.trim()) {
      throw new LedgerVoiceError(
        'VOICE_LEDGER_IDENTITY_INVALID',
        'Ledger signing identity returned an unexpected header.',
      )
    }
    headers.set(name, value)
  }
  return headers
}

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

const readErrorMessage = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const nested = (body?.['error'] as Record<string, unknown> | undefined)?.['message']
  if (typeof nested === 'string') return nested
  const flat = body?.['error'] ?? body?.['message']
  return typeof flat === 'string' ? flat : 'Ledger rejected the request'
}

/** Mints one credential. Also used for rotation — Ledger supersedes the slot. */
export const mintVoiceCredential = async (
  input: LedgerCallInput & { deviceId: string },
): Promise<LedgerVoiceCredential> => {
  const env = input.env ?? process.env
  const { origin, proxyToken } = readLedgerConfig(env)
  const headers = await buildLedgerHeaders(input, proxyToken)
  const fetchImpl = input.fetchImpl ?? safeFetch

  let response: Response
  try {
    response = await fetchImpl(
      new URL(LIVE_TOKEN_PATH, origin),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: input.deviceId }),
        signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
      },
      { maxRedirects: 0 },
    )
  } catch {
    throw new LedgerVoiceError('VOICE_LEDGER_UNAVAILABLE', 'Could not reach Ledger.')
  }

  if (!response.ok) {
    const message = await readErrorMessage(response)
    // 402/403/429 are Ledger's own verdicts (budget, grants, concurrency) and
    // are the caller's to act on; everything else is an upstream fault.
    const status = [402, 403, 429].includes(response.status) ? response.status : 502
    throw new LedgerVoiceError('VOICE_LEDGER_REJECTED', message, status)
  }

  return parseCredential(await response.json().catch(() => null), DEFAULT_GEMINI_LIVE_WEBSOCKET_URL)
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
  const env = input.env ?? process.env
  const { origin, proxyToken } = readLedgerConfig(env)
  const headers = await buildLedgerHeaders(input, proxyToken)
  headers.set('Idempotency-Key', `${input.ledgerSessionId}:${input.sequence}`)
  const fetchImpl = input.fetchImpl ?? safeFetch

  const path = `/v1/gemini/live-sessions/${encodeURIComponent(input.ledgerSessionId)}/usage`
  let response: Response
  try {
    response = await fetchImpl(
      new URL(path, origin),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sequence: input.sequence,
          model: input.model,
          usage: input.usage,
          ...(input.complete ? { complete: true } : {}),
        }),
        signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
      },
      { maxRedirects: 0 },
    )
  } catch {
    throw new LedgerVoiceError('VOICE_LEDGER_UNAVAILABLE', 'Could not reach Ledger.')
  }

  if (!response.ok) {
    const message = await readErrorMessage(response)
    // A conflict means a newer report already landed: the client's queue is
    // behind, not wrong, and it must not keep retrying this one forever.
    const status = response.status === 409 ? 409 : 502
    throw new LedgerVoiceError('VOICE_LEDGER_REJECTED', message, status)
  }

  const body = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>
  return {
    acceptedSequence:
      typeof body['acceptedSequence'] === 'number' ? body['acceptedSequence'] : input.sequence,
    duplicate: body['duplicate'] === true,
    complete: body['complete'] === true,
  }
}
