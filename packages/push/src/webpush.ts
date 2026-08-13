/**
 * Web Push sender — RFC 8030 delivery with RFC 8291 encryption + RFC 8292 VAPID.
 *
 * Mirrors the FCM sender's shape (injectable fetch transport, one-shot helper +
 * reusable client, `PushResult` with dead-subscription detection). Unlike the
 * native senders the request body is BINARY (the encrypted blob), so this module
 * uses its own binary-capable transport rather than the string `FetchLike`.
 */
import { type KeyObject } from 'node:crypto'
import { buildVapidAuthHeader, loadVapidPrivateKey, assertValidVapidSubject } from './vapid.js'
import { encryptWebPushPayload } from './webpush-crypto.js'
import type { PushPayload, PushResult, WebPushCredentials, WebPushTarget } from './types.js'

/** Minimal binary-body HTTP transport, injectable for tests. */
export interface WebPushFetchResponse {
  status: number
  text(): Promise<string>
}

export type WebPushFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: Buffer
  },
) => Promise<WebPushFetchResponse>

/** Per-send delivery options (RFC 8030 headers). */
export interface WebPushSendOptions {
  /** Seconds the push service should retain the message if the UA is offline. */
  ttlSeconds?: number
  /** RFC 8030 §5.3 urgency hint. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60

// A push delivery POST must never be replayed cross-origin: `redirect: 'manual'`
// surfaces any 3xx to the caller, which classifies non-2xx as a failed delivery.
const defaultFetch: WebPushFetch = (url, init) =>
  fetch(url, { ...init, redirect: 'manual' }).then((res) => ({
    status: res.status,
    text: () => res.text(),
  }))

/**
 * Reusable Web Push client. The VAPID private key is parsed once and reused
 * across sends; a per-endpoint JWT is minted on each send (its `aud` is the
 * endpoint origin, so it cannot be shared across push services).
 */
export class WebPushClient {
  private readonly key: KeyObject

  constructor(
    private readonly creds: WebPushCredentials,
    private readonly fetchImpl: WebPushFetch = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {
    assertValidVapidSubject(creds.subject)
    this.key = loadVapidPrivateKey(creds)
  }

  async send(
    target: WebPushTarget,
    payload: PushPayload,
    options: WebPushSendOptions = {},
  ): Promise<PushResult> {
    const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
    let body: Buffer
    let headers: Record<string, string>
    try {
      body = encryptWebPushPayload({
        payload: Buffer.from(JSON.stringify(payload), 'utf8'),
        uaPublicKey: Buffer.from(target.p256dh, 'base64url'),
        authSecret: Buffer.from(target.auth, 'base64url'),
      })
      const nowSeconds = Math.floor(this.now() / 1000)
      headers = {
        // The VAPID JWT lifetime is independent of the message TTL — leave it on
        // the conservative 12h default rather than the message TTL (which can be
        // 24h, the spec ceiling, and risks clock-skew rejection at the service).
        authorization: buildVapidAuthHeader(this.key, this.creds, target.endpoint, nowSeconds),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency: options.urgency ?? 'normal',
      }
    } catch (cause) {
      // Bad key material / malformed subscription — not a transient failure.
      return {
        ok: false,
        status: 0,
        deadToken: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    let status: number
    let text: string
    try {
      const response = await this.fetchImpl(target.endpoint, { method: 'POST', headers, body })
      status = response.status
      text = await response.text()
    } catch (cause) {
      return {
        ok: false,
        status: 0,
        deadToken: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    // 201 Created (and, defensively, any 2xx) means accepted.
    if (status >= 200 && status < 300) {
      return { ok: true, status, deadToken: false }
    }

    // 404 Not Found / 410 Gone → the subscription is permanently invalid.
    const deadToken = status === 404 || status === 410
    return {
      ok: false,
      status,
      deadToken,
      error: text || `Web Push request failed with status ${status}`,
    }
  }
}

/** One-shot convenience: send a single Web Push message and return the result. */
export const sendWebPush = (
  creds: WebPushCredentials,
  target: WebPushTarget,
  payload: PushPayload,
  options?: WebPushSendOptions,
): Promise<PushResult> => new WebPushClient(creds).send(target, payload, options)
