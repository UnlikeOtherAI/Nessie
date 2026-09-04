import type { MicrosoftGraphUser } from './client.js'

export class MicrosoftIdentityError extends Error {
  constructor(reason: string) {
    super(`[comms-microsoft] could not establish account identity: ${reason}`)
    this.name = 'MicrosoftIdentityError'
  }
}

export type MicrosoftTokenIdentity = {
  tenantId: string
  objectId?: string
}

export type MicrosoftAccountIdentity = {
  tenantId: string
  accountId: string
  email: string
  displayName?: string
}

const consumerTenantId = '9188040d-6c67-4c5b-b112-36a304b66dad'

const decodeSegment = (segment: string): unknown => {
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const normalizeMailboxAddress = (value: unknown): string | undefined => {
  const candidate = nonEmpty(value)?.trim()
  // Graph may expose a UPN that is not an SMTP address. It cannot become the
  // connection's address identity unless it is structurally mailbox-shaped.
  if (!candidate || !/^[^\s@]+@[^\s@]+$/.test(candidate)) return undefined
  return candidate.toLowerCase()
}

/**
 * The token was received directly from Microsoft's token endpoint in exchange
 * for a server-held code. These checks bind its tenant claim to our client,
 * while Graph `/me` remains the authority for the mailbox and account id.
 */
export const readMicrosoftTokenIdentity = (
  idToken: string | undefined,
  expectedAudience: string,
  expectedNonce: string,
  nowMs: number,
): MicrosoftTokenIdentity => {
  if (!idToken) throw new MicrosoftIdentityError('no id_token in token response')
  const segments = idToken.split('.')
  if (segments.length !== 3 || !segments[1]) {
    throw new MicrosoftIdentityError('id_token is not a JWT')
  }
  let claims: Record<string, unknown>
  try {
    const decoded = decodeSegment(segments[1])
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('claims are not an object')
    }
    claims = decoded as Record<string, unknown>
  } catch {
    throw new MicrosoftIdentityError('id_token claims could not be decoded')
  }

  const tenantId = nonEmpty(claims.tid)
  const issuer = nonEmpty(claims.iss)
  const audience = claims.aud
  const audienceMatches = Array.isArray(audience)
    ? audience.includes(expectedAudience)
    : audience === expectedAudience
  const standardIssuer = tenantId
    ? `https://login.microsoftonline.com/${tenantId}/v2.0`
    : ''
  const consumerIssuer = tenantId === consumerTenantId
    ? 'https://login.microsoftonline.com/consumers/v2.0'
    : ''
  if (!tenantId || !issuer || (issuer !== standardIssuer && issuer !== consumerIssuer)) {
    throw new MicrosoftIdentityError('id_token issuer or tenant is invalid')
  }
  if (!audienceMatches) {
    throw new MicrosoftIdentityError('id_token audience is not this OAuth client')
  }
  if (claims.nonce !== expectedNonce) {
    throw new MicrosoftIdentityError('id_token nonce does not match the OAuth transaction')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    throw new MicrosoftIdentityError('id_token is expired or has no expiry')
  }
  return { tenantId, objectId: nonEmpty(claims.oid) }
}

/**
 * Graph proves the account that owns the access token. The token's optional
 * tenant object id only corroborates that result; it can never substitute for
 * Graph identity or for a providerAccountId.
 */
export const readMicrosoftAccountIdentity = (
  token: MicrosoftTokenIdentity,
  user: MicrosoftGraphUser,
): MicrosoftAccountIdentity => {
  const accountId = nonEmpty(user.id)
  const email = normalizeMailboxAddress(user.mail)
    ?? normalizeMailboxAddress(user.userPrincipalName)
  if (!accountId) throw new MicrosoftIdentityError('Graph /me returned no account id')
  if (!email) throw new MicrosoftIdentityError('Graph /me returned no email address')
  if (token.objectId && token.objectId !== accountId) {
    throw new MicrosoftIdentityError('id_token account does not match Graph /me')
  }
  return {
    tenantId: token.tenantId,
    accountId,
    email,
    ...(nonEmpty(user.displayName) ? { displayName: user.displayName } : {}),
  }
}
