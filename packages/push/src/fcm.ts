/**
 * FCM sender (HTTP v1 API).
 *
 * Exchanges a service-account JWT for an OAuth access token (cached until
 * ~expiry), POSTs the message, and classifies the response into a
 * {@link PushResult} (including dead-token detection).
 */
import { buildServiceAccountJwt } from './jwt.js'
import type { FetchLike } from './transport.js'
import type {
  FcmCredentials,
  PushPayload,
  PushResult,
  PushTarget,
} from './types.js'

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

/** Refresh the access token this many ms before its stated expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000

/** FCM error statuses that mean the token is permanently invalid. */
const DEAD_TOKEN_ERRORS = new Set(['UNREGISTERED', 'INVALID_ARGUMENT'])

interface ServiceAccount {
  projectId: string
  clientEmail: string
  privateKey: string
  tokenUri: string
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number
}

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init).then((res) => ({
    status: res.status,
    text: () => res.text(),
  }))

/** Parse + validate the service-account JSON into the fields we need. */
export const parseServiceAccount = (json: string): ServiceAccount => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json) as Record<string, unknown>
  } catch (cause) {
    throw new Error(
      `FCM service-account JSON could not be parsed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
  const projectId = parsed.project_id
  const clientEmail = parsed.client_email
  const privateKey = parsed.private_key
  const tokenUri = parsed.token_uri
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('FCM service-account JSON is missing "project_id"')
  }
  if (typeof clientEmail !== 'string' || !clientEmail) {
    throw new Error('FCM service-account JSON is missing "client_email"')
  }
  if (typeof privateKey !== 'string' || !privateKey) {
    throw new Error('FCM service-account JSON is missing "private_key"')
  }
  return {
    projectId,
    clientEmail,
    privateKey,
    tokenUri: typeof tokenUri === 'string' && tokenUri ? tokenUri : DEFAULT_TOKEN_URI,
  }
}

/** Build the FCM v1 message body for a payload + token. */
export const buildFcmBody = (token: string, payload: PushPayload): string => {
  const title = payload.subtitle
    ? `${payload.title} · ${payload.subtitle}`
    : payload.title
  const message: Record<string, unknown> = {
    token,
    notification: { title, body: payload.body },
  }
  if (payload.data !== undefined) message.data = payload.data
  const android: Record<string, unknown> = {}
  const apns: Record<string, unknown> = {}
  if (payload.collapseId !== undefined) {
    android.collapse_key = payload.collapseId
    apns.headers = { 'apns-collapse-id': payload.collapseId }
  }
  if (payload.badge !== undefined) {
    android.notification = { notification_count: payload.badge }
    apns.payload = { aps: { badge: payload.badge } }
  }
  if (Object.keys(android).length > 0) message.android = android
  if (Object.keys(apns).length > 0) message.apns = apns
  return JSON.stringify({ message })
}

const parseFcmError = (body: string): string | undefined => {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: unknown; message?: unknown }
    }
    const status = parsed.error?.status
    if (typeof status === 'string') return status
    const message = parsed.error?.message
    return typeof message === 'string' ? message : undefined
  } catch {
    return undefined
  }
}

const parseMessageId = (body: string): string | undefined => {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { name?: unknown }
    return typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Stateful FCM client: caches the OAuth access token across sends. Bind it to
 * one service account.
 */
export class FcmClient {
  private readonly account: ServiceAccount
  private cachedToken: CachedToken | null = null

  constructor(
    creds: FcmCredentials,
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.account = parseServiceAccount(creds.serviceAccountJson)
  }

  private async accessToken(): Promise<string> {
    const current = this.now()
    if (this.cachedToken && current < this.cachedToken.expiresAtMs - TOKEN_EXPIRY_SKEW_MS) {
      return this.cachedToken.accessToken
    }
    const assertion = buildServiceAccountJwt(
      this.account.privateKey,
      this.account.clientEmail,
      this.account.tokenUri,
      FCM_SCOPE,
      Math.floor(current / 1000),
    )
    const response = await this.fetchImpl(this.account.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })
    const body = await response.text()
    if (response.status !== 200) {
      throw new Error(
        `FCM token exchange failed (${response.status}): ${parseFcmError(body) ?? body}`,
      )
    }
    const parsed = JSON.parse(body) as { access_token?: unknown; expires_in?: unknown }
    if (typeof parsed.access_token !== 'string') {
      throw new Error('FCM token exchange response had no access_token')
    }
    const expiresInSeconds = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600
    this.cachedToken = {
      accessToken: parsed.access_token,
      expiresAtMs: current + expiresInSeconds * 1000,
    }
    return parsed.access_token
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    let accessToken: string
    try {
      accessToken = await this.accessToken()
    } catch (cause) {
      return {
        ok: false,
        status: 0,
        deadToken: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.account.projectId}/messages:send`
    let status: number
    let body: string
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: buildFcmBody(target.token, payload),
      })
      status = response.status
      body = await response.text()
    } catch (cause) {
      return {
        ok: false,
        status: 0,
        deadToken: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }

    if (status === 200) {
      return { ok: true, status, deadToken: false, messageId: parseMessageId(body) }
    }
    const error = parseFcmError(body)
    const deadToken = error ? DEAD_TOKEN_ERRORS.has(error) : false
    return {
      ok: false,
      status,
      deadToken,
      error: error ?? `FCM request failed with status ${status}`,
    }
  }
}

/**
 * One-shot FCM send. Builds a client and sends a single message. Callers should
 * pass an SSRF-safe `fetchImpl`: the service-account `token_uri` is
 * attacker-controllable and the default global fetch validates no URL.
 */
export const sendFcm = (
  creds: FcmCredentials,
  target: PushTarget,
  payload: PushPayload,
  fetchImpl?: FetchLike,
): Promise<PushResult> => new FcmClient(creds, fetchImpl).send(target, payload)
