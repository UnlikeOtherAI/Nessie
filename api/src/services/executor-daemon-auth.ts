import { createHmac, randomBytes } from 'node:crypto'

import { verifyHmacSignature } from '@nessie/runtime'

const CHALLENGE_TTL_MS = 60_000

type ChallengeClaims = {
  executorId: string
  expiresAt: number
  nonce: string
}

const sign = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url')

export const issueExecutorDaemonChallenge = (
  executorId: string,
  secret: string,
  now = new Date(),
): { challenge: string; expiresAt: string } => {
  const claims: ChallengeClaims = {
    executorId,
    expiresAt: now.getTime() + CHALLENGE_TTL_MS,
    nonce: randomBytes(32).toString('base64url'),
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return {
    challenge: `${payload}.${sign(payload, secret)}`,
    expiresAt: new Date(claims.expiresAt).toISOString(),
  }
}

export const verifyExecutorDaemonChallenge = (
  challenge: string,
  executorId: string,
  secret: string,
  now = new Date(),
): boolean => {
  const [payload, signature] = challenge.split('.')
  // Same base64url wire form as before; the comparison is the shared verifier
  // (2026-09-05 review, F5-2) rather than a fourth local timing-safe compare.
  if (
    !payload
    || !verifyHmacSignature({ encoding: 'base64url', payload, secret, signature })
  ) return false
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ChallengeClaims
    return claims.executorId === executorId
      && typeof claims.nonce === 'string'
      && claims.nonce.length >= 32
      && Number.isFinite(claims.expiresAt)
      && claims.expiresAt > now.getTime()
  } catch {
    return false
  }
}
