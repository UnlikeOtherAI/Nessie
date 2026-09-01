/**
 * VAPID (RFC 8292) — Voluntary Application Server Identification for Web Push.
 *
 * The application server proves its identity to the push service with a
 * short-lived ES256 JWT, signed by the VAPID private key. The matching public
 * key travels in the `Authorization` header so the push service can verify it.
 *
 * Keys are the conventional Web Push raw format:
 * - public key  = base64url(0x04 || X(32) || Y(32))  — 65-byte uncompressed point
 * - private key = base64url(d(32))                    — raw P-256 scalar
 *
 * This is the same representation `web-push` and browsers use, so keys generated
 * by `scripts/generate-vapid-keys.mjs` interoperate directly. Plain `node:crypto`
 * — no third-party JWT or crypto library.
 */
import {
  createPrivateKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto'

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url')

const encodeSegment = (value: unknown): string =>
  base64url(JSON.stringify(value))

/** VAPID application-server credentials, already decoded from config/storage. */
export interface VapidKeys {
  /** base64url uncompressed P-256 public point (65 bytes). */
  publicKey: string
  /** base64url raw P-256 private scalar (32 bytes). */
  privateKey: string
  /** Contact `sub` claim — a `mailto:` or `https:` URI for the operator. */
  subject: string
}

/**
 * Build a P-256 private `KeyObject` from the raw VAPID key pair via a JWK.
 * Throws a clear error when the key material is the wrong length or shape.
 */
export const loadVapidPrivateKey = (keys: Pick<VapidKeys, 'publicKey' | 'privateKey'>): KeyObject => {
  const pub = Buffer.from(keys.publicKey, 'base64url')
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(
      `VAPID public key must be a 65-byte uncompressed P-256 point (0x04 prefix), got ${pub.length} bytes`,
    )
  }
  const priv = Buffer.from(keys.privateKey, 'base64url')
  if (priv.length !== 32) {
    throw new Error(`VAPID private key must be a 32-byte P-256 scalar, got ${priv.length} bytes`)
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(pub.subarray(1, 33)),
    y: base64url(pub.subarray(33, 65)),
    d: base64url(priv),
  }
  try {
    return createPrivateKey({ key: jwk, format: 'jwk' })
  } catch (cause) {
    throw new Error(
      `VAPID key pair could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/** Validate the `sub` claim is a `mailto:` or `https:` URI per RFC 8292 §2.1. */
export const assertValidVapidSubject = (subject: string): void => {
  if (!/^(mailto:|https:\/\/).+/i.test(subject)) {
    throw new Error(`VAPID subject must be a "mailto:" or "https://" URI, got "${subject}"`)
  }
}

/**
 * Mint a VAPID ES256 JWT for one push-service origin.
 *
 * Header: `{ typ: 'JWT', alg: 'ES256' }`. Claims: `{ aud, exp, sub }` where
 * `aud` is the push endpoint's origin and `exp` is at most 24h out (RFC 8292
 * §2). The signature uses raw (R||S) IEEE P1363 encoding, as JWS ES256 requires.
 */
export const mintVapidJwt = (
  key: KeyObject,
  audience: string,
  subject: string,
  issuedAtSeconds: number,
  ttlSeconds = 12 * 60 * 60,
): string => {
  const header = { typ: 'JWT', alg: 'ES256' } as const
  const claims = {
    aud: audience,
    exp: issuedAtSeconds + Math.min(ttlSeconds, 24 * 60 * 60),
    sub: subject,
  }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(signature)}`
}

/**
 * Build the `Authorization` header value for a Web Push request using the
 * single-header `vapid` scheme (RFC 8292 §3): `vapid t=<jwt>, k=<publicKey>`.
 */
export const buildVapidAuthHeader = (
  key: KeyObject,
  keys: Pick<VapidKeys, 'publicKey' | 'subject'>,
  endpoint: string,
  issuedAtSeconds: number,
  ttlSeconds?: number,
): string => {
  const audience = new URL(endpoint).origin
  const jwt = mintVapidJwt(key, audience, keys.subject, issuedAtSeconds, ttlSeconds)
  return `vapid t=${jwt}, k=${keys.publicKey}`
}
