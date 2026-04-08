import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuthProviderResponseType } from '@nessie/schemas'

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
): { expiresAt: string; token: string } => {
  const issuedAt = Math.floor(Date.now() / 1000)
  const claims: SessionTokenClaims = {
    ...input,
    exp: issuedAt + ttlSeconds,
    iat: issuedAt,
    sid: randomUUID(),
  }

  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = encodeBase64Url(JSON.stringify(claims))
  const signature = signTokenValue(`${header}.${payload}`, secret)

  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  }
}

export const verifySessionToken = (
  token: string,
  secret: string,
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
    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      return { ok: false, code: 'TOKEN_EXPIRED', message: 'Session expired' }
    }

    return { ok: true, claims }
  } catch {
    return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid session token' }
  }
}
