/**
 * APNs sender (token-based auth, HTTP/2).
 *
 * Mints + caches an ES256 JWT (≤ 20 min), reuses a single HTTP/2 session per
 * host, builds the APNs JSON payload, and classifies the response into a
 * {@link PushResult} (including dead-token detection).
 */
import type { KeyObject } from 'node:crypto'
import { loadApnsKey, mintApnsJwt } from './jwt.js'
import { createHttp2Transport } from './http2-transport.js'
import type { ApnsTransport, ApnsTransportFactory } from './transport.js'
import type {
  ApnsCredentials,
  PushPayload,
  PushResult,
  PushTarget,
} from './types.js'

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const

/** Re-mint the auth JWT after this many milliseconds (Apple allows ≤ 60 min). */
const JWT_TTL_MS = 20 * 60 * 1000

/** APNs reasons that mean the token is permanently invalid. */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered'])

interface CachedJwt {
  token: string
  mintedAt: number
}

/** Build the standard APNs JSON body for a payload. */
export const buildApnsBody = (payload: PushPayload): string => {
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
  }
  if (payload.badge !== undefined) aps.badge = payload.badge
  if (payload.collapseId !== undefined) aps['thread-id'] = payload.collapseId
  return JSON.stringify({ aps, ...(payload.data ?? {}) })
}

const parseReason = (body: string): string | undefined => {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { reason?: unknown }
    return typeof parsed.reason === 'string' ? parsed.reason : undefined
  } catch {
    return undefined
  }
}

/**
 * Stateful APNs client: caches the auth JWT and the HTTP/2 session across
 * sends. Bind it to one set of credentials.
 */
export class ApnsClient {
  private readonly key: KeyObject
  private cachedJwt: CachedJwt | null = null
  private transport: ApnsTransport | null = null

  constructor(
    private readonly creds: ApnsCredentials,
    private readonly transportFactory: ApnsTransportFactory = createHttp2Transport,
    private readonly now: () => number = Date.now,
  ) {
    this.key = loadApnsKey(creds.p8)
  }

  private authToken(): string {
    const current = this.now()
    if (this.cachedJwt && current - this.cachedJwt.mintedAt < JWT_TTL_MS) {
      return this.cachedJwt.token
    }
    const token = mintApnsJwt(
      this.key,
      this.creds.keyId,
      this.creds.teamId,
      Math.floor(current / 1000),
    )
    this.cachedJwt = { token, mintedAt: current }
    return token
  }

  private getTransport(): ApnsTransport {
    if (!this.transport) {
      this.transport = this.transportFactory(APNS_HOSTS[this.creds.environment])
    }
    return this.transport
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    const headers: Record<string, string> = {
      authorization: `bearer ${this.authToken()}`,
      'apns-topic': this.creds.topic,
      'apns-push-type': 'alert',
    }
    if (payload.collapseId !== undefined) {
      headers['apns-collapse-id'] = payload.collapseId
    }

    let status: number
    let apnsId: string | undefined
    let body: string
    try {
      const response = await this.getTransport().send({
        method: 'POST',
        path: `/3/device/${target.token}`,
        headers,
        body: buildApnsBody(payload),
      })
      status = response.status
      apnsId = response.apnsId
      body = response.body
    } catch (cause) {
      return {
        ok: false,
        status: 0,
        deadToken: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    if (status === 200) {
      return { ok: true, status, deadToken: false, messageId: apnsId }
    }
    const reason = parseReason(body)
    const deadToken = status === 410 || (reason ? DEAD_TOKEN_REASONS.has(reason) : false)
    return {
      ok: false,
      status,
      deadToken,
      error: reason ?? `APNs request failed with status ${status}`,
    }
  }

  /** Tear down the underlying HTTP/2 session. */
  async close(): Promise<void> {
    if (this.transport) {
      const transport = this.transport
      this.transport = null
      await transport.close()
    }
  }
}

/** One-shot APNs send. Builds a client, sends, and tears the session down. */
export const sendApns = async (
  creds: ApnsCredentials,
  target: PushTarget,
  payload: PushPayload,
): Promise<PushResult> => {
  const client = new ApnsClient(creds)
  try {
    return await client.send(target, payload)
  } finally {
    await client.close()
  }
}
