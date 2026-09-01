import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const CHALLENGE_TTL_MS = 60_000

type ChallengeClaims = {
  executorId: string
  expiresAt: number
  nonce: string
}

const sign = (value: string, secret: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url')

const tokenMatches = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

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
  if (!payload || !signature || !tokenMatches(signature, sign(payload, secret))) return false
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
