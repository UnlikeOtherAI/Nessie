import crypto from 'node:crypto'

/**
 * Push-credential validation + signing.
 *
 * Two jobs:
 *  - APNs: parse the uploaded `.p8` as a PKCS#8 EC private key and mint the
 *    short-lived ES256 JWT Apple's token-based auth requires. If it signs, the
 *    key is valid; the same JWT is what the gateway sends to `api.push.apple.com`.
 *  - FCM: parse the service-account JSON, assert the required shape, and do a
 *    Google OAuth2 JWT-bearer token exchange to prove the account is live.
 *
 * No third-party JWT lib: ES256/RS256 signing is `node:crypto` + manual
 * base64url JOSE encoding, which keeps the dependency surface minimal.
 */

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url')

export const PUSH_VALIDATION_ERROR_CODES = {
  APNS_KEY_INVALID: 'APNS_KEY_INVALID',
  APNS_KEY_ID_MISSING: 'APNS_KEY_ID_MISSING',
  FCM_JSON_INVALID: 'FCM_JSON_INVALID',
  FCM_EXCHANGE_FAILED: 'FCM_EXCHANGE_FAILED',
} as const
export type PushValidationErrorCode =
  (typeof PUSH_VALIDATION_ERROR_CODES)[keyof typeof PUSH_VALIDATION_ERROR_CODES]

export class PushValidationError extends Error {
  constructor(
    public readonly code: PushValidationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PushValidationError'
  }
}

// ─── APNs ────────────────────────────────────────────────────────────────────

const APNS_KEY_ID_FILENAME = /^AuthKey_([A-Z0-9]+)\.p8$/i

/**
 * Derive the APNs Key ID from a canonical `AuthKey_<KEYID>.p8` filename.
 * Returns null when the filename does not match (the caller must then require
 * an explicit `keyId` field).
 */
export const deriveApnsKeyIdFromFilename = (
  filename: string | undefined,
): string | null => {
  if (!filename) return null
  const match = APNS_KEY_ID_FILENAME.exec(filename.trim())
  return match?.[1] ?? null
}

/**
 * Mint the APNs auth JWT (header `{alg:ES256, kid:keyId}`, claims
 * `{iss:teamId, iat}`) from a `.p8` PKCS#8 EC private key. Throws
 * {@link PushValidationError} `APNS_KEY_INVALID` if the key cannot be parsed
 * or cannot sign — which doubles as the upload validation.
 */
export const mintApnsJwt = (input: {
  p8: string
  keyId: string
  teamId: string
  issuedAt?: number
}): string => {
  let privateKey: crypto.KeyObject
  try {
    privateKey = crypto.createPrivateKey({ key: input.p8, format: 'pem' })
  } catch (error) {
    throw new PushValidationError(
      PUSH_VALIDATION_ERROR_CODES.APNS_KEY_INVALID,
      `Could not parse the .p8 key as a PKCS#8 private key: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  // ES256 is ECDSA over the P-256 curve. `createPrivateKey` happily parses RSA
  // and other keys, and `crypto.sign('SHA256', …)` would then produce a (wrong)
  // RSA signature instead of failing — so reject anything that is not EC/P-256
  // up front. Apple only ever issues P-256 `.p8` auth keys.
  if (
    privateKey.asymmetricKeyType !== 'ec'
    || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new PushValidationError(
      PUSH_VALIDATION_ERROR_CODES.APNS_KEY_INVALID,
      'APNs auth keys must be an EC P-256 (.p8) key; '
        + `got ${privateKey.asymmetricKeyType ?? 'unknown'} `
        + `(${privateKey.asymmetricKeyDetails?.namedCurve ?? 'no curve'}).`,
    )
  }

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: input.keyId }))
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({ iss: input.teamId, iat }))
  const signingInput = `${header}.${payload}`

  let signature: Buffer
  try {
    // APNs requires ES256 = ECDSA over P-256 with a fixed-length (r||s) JOSE
    // signature, not the DER encoding Node emits by default.
    signature = crypto.sign('SHA256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    })
  } catch (error) {
    throw new PushValidationError(
      PUSH_VALIDATION_ERROR_CODES.APNS_KEY_INVALID,
      `The .p8 key could not produce an ES256 signature (not an EC key?): ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
  }

  return `${signingInput}.${base64url(signature)}`
}

// ─── FCM ───────────────────────────────────────────────────────────────────

export type FcmServiceAccount = {
  type: string
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/**
 * Parse + shape-validate an FCM service-account JSON. Throws
 * {@link PushValidationError} `FCM_JSON_INVALID` on any structural problem.
 */
export const parseFcmServiceAccount = (raw: string): FcmServiceAccount => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PushValidationError(
      PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
      'The FCM credential file is not valid JSON.',
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new PushValidationError(
      PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
      'The FCM credential file must be a JSON object.',
    )
  }

  const obj = parsed as Record<string, unknown>
  if (obj['type'] !== 'service_account') {
    throw new PushValidationError(
      PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
      'Expected a Firebase service-account JSON (type: "service_account").',
    )
  }

  for (const field of ['project_id', 'client_email', 'private_key'] as const) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      throw new PushValidationError(
        PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
        `The FCM service-account JSON is missing "${field}".`,
      )
    }
  }

  return {
    type: 'service_account',
    project_id: obj['project_id'] as string,
    client_email: obj['client_email'] as string,
    private_key: obj['private_key'] as string,
    token_uri: typeof obj['token_uri'] === 'string'
      ? (obj['token_uri'] as string)
      : undefined,
  }
}

const mintGoogleAssertion = (account: FcmServiceAccount): string => {
  const iat = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: account.token_uri ?? GOOGLE_TOKEN_URI,
      iat,
      exp: iat + 3600,
    }),
  )
  const signingInput = `${header}.${payload}`
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput),
    account.private_key,
  )
  return `${signingInput}.${base64url(signature)}`
}

export type FcmTokenExchange = (account: FcmServiceAccount) => Promise<{
  ok: boolean
  message: string
}>

/**
 * Live Google OAuth2 JWT-bearer token exchange — proves the service account
 * is active. Timeboxed; network failures surface as `ok: false` rather than
 * throwing so callers can report a clean error. Injectable so tests mock it.
 */
export const liveFcmTokenExchange: FcmTokenExchange = async (account) => {
  const assertion = mintGoogleAssertion(account)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(account.token_uri ?? GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        ok: false,
        message: `Google rejected the service account (HTTP ${response.status}): ${text.slice(0, 200)}`,
      }
    }
    return { ok: true, message: 'FCM service account is live.' }
  } catch (error) {
    return {
      ok: false,
      message: `FCM token exchange failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    }
  } finally {
    clearTimeout(timeout)
  }
}
