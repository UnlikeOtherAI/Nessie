import { createHash, createHmac } from 'node:crypto'

const SUCCESSOR_HMAC_DOMAIN = 'nessie.refresh-token.successor.v1\u0000'

export const hashRefreshToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex')

export const deriveRefreshTokenSuccessor = (
  rawToken: string,
  authSecret: string,
): string => createHmac('sha256', authSecret)
  .update(SUCCESSOR_HMAC_DOMAIN)
  .update(rawToken)
  .digest('base64url')
