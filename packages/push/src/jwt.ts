/**
 * JWT minting for the two push providers.
 *
 * - APNs uses a short-lived ES256 token signed with the .p8 EC P-256 key.
 * - FCM uses an RS256 service-account assertion exchanged for an OAuth access
 *   token.
 *
 * Both are plain `node:crypto` — no third-party JWT library.
 */
import {
  createPrivateKey,
  createSign,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto'

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url')

const encodeSegment = (value: unknown): string =>
  base64url(JSON.stringify(value))

/**
 * Load and validate the APNs .p8 key as an EC P-256 private key.
 * Throws a clear error if the key is missing, malformed, or not P-256.
 */
export const loadApnsKey = (p8: string): KeyObject => {
  let key: KeyObject
  try {
    key = createPrivateKey(p8)
  } catch (cause) {
    throw new Error(
      `APNs .p8 key could not be parsed as a private key: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error(
      `APNs .p8 key must be an EC key, got "${key.asymmetricKeyType ?? 'unknown'}"`,
    )
  }
  const curve = key.asymmetricKeyDetails?.namedCurve
  if (curve !== 'prime256v1') {
    throw new Error(
      `APNs .p8 key must use the P-256 curve (prime256v1), got "${curve ?? 'unknown'}"`,
    )
  }
  return key
}

/**
 * Mint an APNs ES256 auth JWT.
 *
 * Header: `{ alg: 'ES256', kid: keyId }`. Claims: `{ iss: teamId, iat }`.
 * The signature uses the raw (R||S) IEEE P1363 encoding APNs requires.
 */
export const mintApnsJwt = (
  key: KeyObject,
  keyId: string,
  teamId: string,
  issuedAtSeconds: number,
): string => {
  const header = { alg: 'ES256', kid: keyId } as const
  const claims = { iss: teamId, iat: issuedAtSeconds }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(signature)}`
}

/**
 * Build an RS256 service-account JWT assertion for an OAuth token exchange.
 *
 * Claims: `{ iss: clientEmail, scope, aud: tokenUri, iat, exp }`.
 */
export const buildServiceAccountJwt = (
  privateKeyPem: string,
  clientEmail: string,
  tokenUri: string,
  scope: string,
  issuedAtSeconds: number,
  lifetimeSeconds = 3600,
): string => {
  const header = { alg: 'RS256', typ: 'JWT' } as const
  const claims = {
    iss: clientEmail,
    scope,
    aud: tokenUri,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + lifetimeSeconds,
  }
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(privateKeyPem)
  return `${signingInput}.${base64url(signature)}`
}
