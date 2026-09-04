import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_CLOCK_SKEW_MS = 60_000
const MIN_CONTROL_SECRET_BYTES = 32

/**
 * The control bridge is an authority to mutate UOA-backed membership. A
 * human-readable password is not an acceptable HMAC key: deployments must
 * provision at least 256 bits of secret material (for example,
 * `openssl rand -base64 48`).
 */
export const hasStrongUoaAutomaticMembershipControlSecret = (
  secret: string | undefined,
): boolean => Boolean(secret && Buffer.byteLength(secret, 'utf8') >= MIN_CONTROL_SECRET_BYTES)

const timestampAsMilliseconds = (value: string | null): number | null => {
  if (!value || !/^\d{13}$/.test(value)) return null
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

/** Verifies the UOA contract over parsed JSON, with no alternate encoding. */
export const verifyUoaAutomaticMembershipControlSignature = (
  secret: string | undefined,
  timestamp: string | null,
  signature: string | null,
  parsedBody: unknown,
  now = Date.now(),
): boolean => {
  const parsedTimestamp = timestampAsMilliseconds(timestamp)
  if (!hasStrongUoaAutomaticMembershipControlSecret(secret)
    || !parsedTimestamp || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false
  if (Math.abs(now - parsedTimestamp) > MAX_CLOCK_SKEW_MS) return false
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(parsedBody)}`)
    .digest()
  const supplied = Buffer.from(signature, 'hex')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

type ControlRequestLedger = {
  deleteMany(input: { where: { expiresAt: { lte: Date } } }): Promise<unknown>
  create(input: { data: {
    requestId: string
    requestDigest: string
    organizationId: string
    uoaActorSub: string
    action: string
    expiresAt: Date
  } }): Promise<unknown>
}

/** Returns false for a live duplicate request id, including concurrent callers. */
export const reserveUoaAutomaticMembershipControlRequest = async (
  ledger: ControlRequestLedger,
  input: {
    requestId: string
    requestDigest: string
    organizationId: string
    uoaActorSub: string
    action: string
    now?: Date
    ttlMs: number
  },
): Promise<boolean> => {
  const now = input.now ?? new Date()
  const request = {
    requestId: input.requestId,
    requestDigest: input.requestDigest,
    organizationId: input.organizationId,
    uoaActorSub: input.uoaActorSub,
    action: input.action,
  }
  await ledger.deleteMany({ where: { expiresAt: { lte: now } } })
  try {
    await ledger.create({ data: { ...request, expiresAt: new Date(now.getTime() + input.ttlMs) } })
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') return false
    throw error
  }
}
