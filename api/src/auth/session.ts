import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  UoaSessionIdentitySchema,
  type AuthProviderResponseType,
  type UoaSessionIdentity,
} from '@nessie/schemas'

export type SessionTokenClaims = {
  exp: number
  iat: number
  org: string
  proj: string
  providerId: string
  providerType: AuthProviderResponseType
  roles: string[]
  sid: string
  sub: string
  team: string
  // Server-issued generation for native device registration context changes.
  pv?: string
  // `User.tokenVersion` at issue time. A mismatch on verify means this token was
  // revoked (logout, forced sign-out), so it is rejected before its TTL expires.
  // Distinct from `uoaIdentity.uoaTokenVersion`, which is UOA's own epoch.
  tv?: number
  uoaIdentity?: UoaSessionIdentity
}

export type SessionTokenInput = Omit<SessionTokenClaims, 'exp' | 'iat' | 'sid'>

type VerificationResult =
  | { ok: true; claims: SessionTokenClaims }
  | { ok: false; code: 'TOKEN_EXPIRED' | 'TOKEN_INVALID'; message: string }

const encodeBase64Url = (value: string): string => Buffer.from(value).toString('base64url')
const decodeBase64Url = (value: string): string => Buffer.from(value, 'base64url').toString()

const signTokenValue = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url')

export const issueSessionToken = (
  input: SessionTokenInput,
  secret: string,
  ttlSeconds: number,
  // A fresh login mints a new session id; a refresh passes the existing one so
  // the access token's `sid` stays stable across a login's rotation chain
  // (keeps session listing/revocation and session-scoped state coherent).
  sessionId?: string,
): {
  // The claims the token carries, returned so a caller never has to verify a
  // token it has just signed to recover them (2026-09-05 review, FO3-8).
  claims: SessionTokenClaims
  expiresAt: string
  sessionId: string
  token: string
} => {
  const issuedAt = Math.floor(Date.now() / 1000)
  const claims: SessionTokenClaims = {
    ...input,
    exp: issuedAt + ttlSeconds,
    iat: issuedAt,
    sid: sessionId ?? randomUUID(),
  }

  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = encodeBase64Url(JSON.stringify(claims))
  const signature = signTokenValue(`${header}.${payload}`, secret)

  return {
    claims,
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    sessionId: claims.sid,
  }
}

/**
 * True when this token predates the user's current revocation generation.
 *
 * A user-wide forced sign-out bumps `User.tokenVersion`; every access token
 * minted at an older generation must stop working immediately. Exact-session
 * logout is enforced separately by the live refresh-session `sid` check.
 * Tokens issued before this claim carry no `tv` and read as generation 0.
 */
export const isSessionTokenRevoked = (
  claims: Pick<SessionTokenClaims, 'tv'>,
  currentTokenVersion: number,
): boolean => (claims.tv ?? 0) !== currentTokenVersion

const verifySessionTokenValue = (
  token: string,
  secret: string,
  allowExpired: boolean,
): VerificationResult => {
  const [header, payload, signature] = token.split('.')

  if (!header || !payload || !signature) {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid session token' }
  }

  const expectedSignature = signTokenValue(`${header}.${payload}`, secret)
  const actualSignatureBuffer = Buffer.from(signature)
  const expectedSignatureBuffer = Buffer.from(expectedSignature)

  if (
    actualSignatureBuffer.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(actualSignatureBuffer, expectedSignatureBuffer)
  ) {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid session token' }
  }

  try {
    const claims = JSON.parse(decodeBase64Url(payload)) as SessionTokenClaims
    if (!allowExpired && claims.exp <= Math.floor(Date.now() / 1000)) {
      return { ok: false, code: 'TOKEN_EXPIRED', message: 'Session expired' }
    }
    if (
      claims.uoaIdentity !== undefined
      && (
        claims.providerType !== 'uoa'
        || !UoaSessionIdentitySchema.safeParse(claims.uoaIdentity).success
      )
    ) {
      return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid session token' }
    }

    return { ok: true, claims }
  } catch {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid session token' }
  }
}

export const verifySessionToken = (
  token: string,
  secret: string,
): VerificationResult => verifySessionTokenValue(token, secret, false)

/** Logout authenticates an exact old session even after its access TTL ends. */
export const verifySessionTokenForLogout = (
  token: string,
  secret: string,
): VerificationResult => verifySessionTokenValue(token, secret, true)
