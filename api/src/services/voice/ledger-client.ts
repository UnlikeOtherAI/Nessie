import {
  attributionFromActorContext,
  safeFetch,
  type LedgerIdentityService,
} from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

const LEDGER_TIMEOUT_MS = 15_000
const ALLOWED_IDENTITY_HEADERS = new Set(['x-nessie-context', 'x-uoa-delegation'])

export type LedgerVoiceCallInput = {
  actorContext: AuthorizedActionContext
  ledgerIdentity: LedgerIdentityService | null
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof safeFetch
  /** Test seam for asserting an operation-specific deadline without waiting. */
  timeoutSignalFactory?: (timeoutMs: number) => AbortSignal
}

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

export const isLedgerConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env['LEDGER_PUBLIC_URL']?.trim() && env['LEDGER_PROXY_TOKEN']?.trim())

const readConfig = (env: NodeJS.ProcessEnv) => {
  const baseUrl = env['LEDGER_PUBLIC_URL']?.trim()
  const proxyToken = env['LEDGER_PROXY_TOKEN']?.trim()
  if (!baseUrl || !proxyToken) {
    throw new LedgerVoiceError('VOICE_LEDGER_UNCONFIGURED', 'Voice transcription requires Ledger configuration.', 503)
  }
  try {
    return { origin: new URL(baseUrl).origin, proxyToken }
  } catch {
    throw new LedgerVoiceError('VOICE_LEDGER_UNCONFIGURED', 'LEDGER_PUBLIC_URL is not a valid URL.', 503)
  }
}

async function headers(input: LedgerVoiceCallInput, proxyToken: string, systemComponent: string) {
  const result = new Headers({
    Authorization: `Bearer ${proxyToken}`,
    'Content-Type': 'application/json',
  })
  if (!input.ledgerIdentity) return result
  const attribution = attributionFromActorContext(input.actorContext, { systemComponent })
  const identityHeaders = await input.ledgerIdentity.requestHeaders(attribution, { requireUoaIdentity: true })
  for (const [name, value] of Object.entries(identityHeaders)) {
    if (!ALLOWED_IDENTITY_HEADERS.has(name.toLowerCase()) || !value.trim()) {
      throw new LedgerVoiceError('VOICE_LEDGER_IDENTITY_INVALID', 'Ledger signing identity returned an unexpected header.')
    }
    result.set(name, value)
  }
  return result
}

const errorMessage = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const nested = (body?.['error'] as Record<string, unknown> | undefined)?.['message']
  if (typeof nested === 'string') return nested
  const flat = body?.['error'] ?? body?.['message']
  return typeof flat === 'string' ? flat : 'Ledger rejected the request'
}

/** Calls a private Ledger JSON route without ever exposing its app key. */
export const postLedgerJson = async <T>(input: LedgerVoiceCallInput & {
  path: string
  body: unknown
  systemComponent: string
  idempotencyKey?: string
  acceptedStatuses?: readonly number[]
  /** A transcription can legitimately spend 10s on OAuth and 20s at Google;
   * it must outlive the generic broker timeout or its settled text is lost. */
  timeoutMs?: number
}): Promise<T> => {
  const { origin, proxyToken } = readConfig(input.env ?? process.env)
  const requestHeaders = await headers(input, proxyToken, input.systemComponent)
  if (input.idempotencyKey) requestHeaders.set('Idempotency-Key', input.idempotencyKey)
  let response: Response
  try {
    response = await (input.fetchImpl ?? safeFetch)(
      new URL(input.path, origin),
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(input.body),
        signal: (input.timeoutSignalFactory ?? AbortSignal.timeout)(input.timeoutMs ?? LEDGER_TIMEOUT_MS),
      },
      { maxRedirects: 0 },
    )
  } catch {
    throw new LedgerVoiceError('VOICE_LEDGER_UNAVAILABLE', 'Could not reach Ledger.')
  }
  if (!response.ok) {
    const status = input.acceptedStatuses?.includes(response.status) ? response.status : 502
    throw new LedgerVoiceError('VOICE_LEDGER_REJECTED', await errorMessage(response), status)
  }
  return await response.json().catch(() => null) as T
}
