import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

const TOKEN_VERSION = 'v1'
const TOKEN_DOMAIN = 'nessie.call-action-token.v1\0'

const CallActionTokenClaimsSchema = z.object({
  action: z.enum(['accept', 'decline']),
  callId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  userId: z.string().uuid(),
}).strict()

export type CallActionTokenClaims = z.infer<typeof CallActionTokenClaimsSchema>

const sign = (encodedClaims: string, secret: string): string =>
  createHmac('sha256', secret)
    .update(TOKEN_DOMAIN)
    .update(encodedClaims)
    .digest('base64url')

/**
 * A compact action token for the unauthenticated Web Push response route.
 * Its state-changing single use is enforced by the call invite's conditional
 * ringing -> response transition; the signature keeps every bound field intact.
 */
export const issueCallActionToken = (
  claims: CallActionTokenClaims,
  secret: string,
): string => {
  const encodedClaims = Buffer.from(JSON.stringify(CallActionTokenClaimsSchema.parse(claims))).toString('base64url')
  return `${TOKEN_VERSION}.${encodedClaims}.${sign(encodedClaims, secret)}`
}

export const verifyCallActionToken = (
  token: string,
  secret: string,
  now: Date = new Date(),
): CallActionTokenClaims | null => {
  const [version, encodedClaims, providedSignature, ...extra] = token.split('.')
  if (version !== TOKEN_VERSION || !encodedClaims || !providedSignature || extra.length > 0) return null

  const expectedSignature = sign(encodedClaims, secret)
  const provided = Buffer.from(providedSignature)
  const expected = Buffer.from(expectedSignature)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null

  try {
    const claims = CallActionTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')),
    )
    return claims.expiresAt > Math.floor(now.getTime() / 1000) ? claims : null
  } catch {
    return null
  }
}
