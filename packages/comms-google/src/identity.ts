/**
 * Account identity for a Google connection, taken from the OIDC `id_token`
 * returned alongside the access token.
 *
 * This exists because identity used to come from Gmail's `users.getProfile`,
 * which requires a Gmail read scope. A Calendar-only, send-only or Meet-only
 * connection has no such scope, so connecting one failed outright — the
 * capability catalog is unusable without this. `openid email profile` is
 * requested on every connect precisely so this always resolves.
 *
 * The token arrives over TLS directly from Google's token endpoint in response
 * to a request we made, so per Google's own guidance the signature need not be
 * re-verified here; the issuer, audience and expiry are still checked, because
 * those are what bind the token to *our* OAuth client rather than to some other
 * relying party's.
 */

export class GoogleIdentityError extends Error {
  constructor(reason: string) {
    super(`[comms-google] could not establish account identity: ${reason}`)
    this.name = 'GoogleIdentityError'
  }
}

export type GoogleAccountIdentity = {
  /** Google's stable, immutable account id (`sub`) — never reused, never changes. */
  accountId: string
  /** The account's email address; human-readable and the natural key today. */
  email: string
  /** Workspace hosted domain when present; absent for consumer accounts. */
  hostedDomain?: string
}

const VALID_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
])

const decodeSegment = (segment: string): unknown => {
  // base64url → base64, then a Buffer decode. A malformed segment throws and is
  // caught by the caller, which turns it into a typed identity failure.
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

const readString = (claims: Record<string, unknown>, key: string): string | undefined => {
  const value = claims[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse and validate a Google `id_token`, returning the account identity.
 *
 * @param idToken raw JWT from the token endpoint
 * @param expectedAudience our OAuth client id — a token minted for a different
 *   client must never be accepted as proof of who connected
 * @param nowMs clock seam
 */
export const readGoogleIdentity = (
  idToken: string | undefined,
  expectedAudience: string,
  nowMs: number,
): GoogleAccountIdentity => {
  if (!idToken) {
    throw new GoogleIdentityError('no id_token in the token response')
  }
  const segments = idToken.split('.')
  if (segments.length !== 3 || !segments[1]) {
    throw new GoogleIdentityError('id_token is not a JWT')
  }

  let claims: Record<string, unknown>
  try {
    const decoded = decodeSegment(segments[1])
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('claims are not an object')
    }
    claims = decoded as Record<string, unknown>
  } catch {
    throw new GoogleIdentityError('id_token claims could not be decoded')
  }

  const issuer = readString(claims, 'iss')
  if (!issuer || !VALID_ISSUERS.has(issuer)) {
    throw new GoogleIdentityError('id_token issuer is not Google')
  }

  // `aud` pins the token to this deployment's own OAuth client.
  const audience = claims.aud
  const audienceMatches = Array.isArray(audience)
    ? audience.includes(expectedAudience)
    : audience === expectedAudience
  if (!audienceMatches) {
    throw new GoogleIdentityError('id_token audience is not this OAuth client')
  }

  const exp = claims.exp
  if (typeof exp !== 'number' || exp * 1000 <= nowMs) {
    throw new GoogleIdentityError('id_token is expired or has no expiry')
  }

  const accountId = readString(claims, 'sub')
  if (!accountId) {
    throw new GoogleIdentityError('id_token carries no subject')
  }

  const email = readString(claims, 'email')
  if (!email) {
    throw new GoogleIdentityError('id_token carries no email address')
  }
  // An unverified address must not become an account identity: it would let a
  // connection claim a mailbox its owner never proved.
  if (claims.email_verified === false) {
    throw new GoogleIdentityError('id_token email address is not verified')
  }

  const hostedDomain = readString(claims, 'hd')
  return {
    accountId,
    email,
    ...(hostedDomain ? { hostedDomain } : {}),
  }
}
