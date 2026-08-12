import { randomBytes, timingSafeEqual } from 'node:crypto'

const PROOF_BYTES = 32
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MIN_SESSION_LIFETIME_MS = 60_000
const MAX_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000
const CLIENT_TOKEN_LIFETIME_MS = 45_000
const MAX_LIVE_CLIENT_TOKENS = 8

export type CodingProvider = 'anthropic' | 'openai'

export type CodingSessionBrokerCredential = {
  provider: CodingProvider
  /**
   * A user-owned provider credential resolved locally by the companion. It is
   * deliberately not a persisted executor field and is never returned to the
   * guest-facing caller.
   */
  secret: string
}

type BrokerAuthorization = {
  headers: Record<string, string>
  provider: CodingProvider
}

export type CodingSessionBroker = {
  authorize: (clientToken: string) => BrokerAuthorization | undefined
  issueClientToken: (sessionProof: string) => string | undefined
  provider: CodingProvider
  revoke: () => void
  sessionProof: string
}

export class CodingSessionBrokerError extends Error {
  override readonly name = 'CodingSessionBrokerError'
}

const nowMilliseconds = (): number => Date.now()

const assertCredential = (credential: CodingSessionBrokerCredential): void => {
  if (
    (credential.provider !== 'anthropic' && credential.provider !== 'openai')
    || typeof credential.secret !== 'string'
    || credential.secret.length < 1
    || credential.secret.length > 4_096
    || credential.secret.trim() !== credential.secret
    || /[\u0000-\u001f\u007f]/.test(credential.secret)
  ) {
    throw new CodingSessionBrokerError('The local coding credential is unavailable.')
  }
}

const validLifetime = (value: number): boolean => (
  Number.isInteger(value)
  && value >= MIN_SESSION_LIFETIME_MS
  && value <= MAX_SESSION_LIFETIME_MS
)

const equalProof = (left: string, right: string): boolean => {
  if (!PROOF_PATTERN.test(left) || !PROOF_PATTERN.test(right)) return false
  const leftBytes = Buffer.from(left, 'base64url')
  const rightBytes = Buffer.from(right, 'base64url')
  return leftBytes.length === PROOF_BYTES
    && rightBytes.length === PROOF_BYTES
    && timingSafeEqual(leftBytes, rightBytes)
}

const newProof = (): string => randomBytes(PROOF_BYTES).toString('base64url')

/**
 * Holds a user-owned coding credential only for one live VM session. The
 * guest receives a route-local proof and refreshable short-lived client token;
 * it never receives the provider credential. A broker is intentionally
 * in-memory and is revoked with the VM/gateway session.
 */
export const createCodingSessionBroker = (
  credential: CodingSessionBrokerCredential,
  options: {
    lifetimeMs?: number
    now?: () => number
    randomToken?: () => string
  } = {},
): CodingSessionBroker => {
  assertCredential(credential)
  const lifetimeMs = options.lifetimeMs ?? 60 * 60 * 1_000
  if (!validLifetime(lifetimeMs)) {
    throw new CodingSessionBrokerError('The coding session lifetime is invalid.')
  }
  const now = options.now ?? nowMilliseconds
  const randomToken = options.randomToken ?? newProof
  const sessionProof = randomToken()
  if (!PROOF_PATTERN.test(sessionProof)) {
    throw new CodingSessionBrokerError('The local coding credential is unavailable.')
  }
  const expiresAt = now() + lifetimeMs
  let active = true
  let providerSecret: string | undefined = credential.secret
  const provider = credential.provider
  const clientTokens = new Map<string, number>()

  const prune = (time: number): void => {
    for (const [token, tokenExpiresAt] of clientTokens) {
      if (tokenExpiresAt <= time) clientTokens.delete(token)
    }
  }
  const live = (time: number): boolean => active && time < expiresAt

  return {
    authorize: (clientToken) => {
      const time = now()
      prune(time)
      if (!live(time) || !providerSecret || !PROOF_PATTERN.test(clientToken)) return undefined
      const tokenExpiresAt = clientTokens.get(clientToken)
      if (tokenExpiresAt === undefined || tokenExpiresAt <= time) return undefined
      const headers: Record<string, string> = provider === 'openai'
          ? { authorization: `Bearer ${providerSecret}` }
          : { 'x-api-key': providerSecret }
      return {
        headers,
        provider,
      }
    },
    issueClientToken: (proof) => {
      const time = now()
      prune(time)
      if (!live(time) || !equalProof(proof, sessionProof) || clientTokens.size >= MAX_LIVE_CLIENT_TOKENS) {
        return undefined
      }
      const token = randomToken()
      if (!PROOF_PATTERN.test(token) || clientTokens.has(token)) return undefined
      clientTokens.set(token, Math.min(expiresAt, time + CLIENT_TOKEN_LIFETIME_MS))
      return token
    },
    provider,
    revoke: () => {
      active = false
      providerSecret = undefined
      clientTokens.clear()
    },
    sessionProof,
  }
}
