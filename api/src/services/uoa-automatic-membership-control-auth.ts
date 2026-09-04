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
  if (!secret || !hasStrongUoaAutomaticMembershipControlSecret(secret)
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
  findUnique(input: {
    where: { requestId: string }
    select: { requestDigest: true; completedAt: true }
  }): Promise<{ requestDigest: string; completedAt: Date | null } | null>
  update(input: { where: { requestId: string }; data: { completedAt: Date } }): Promise<unknown>
}

export type UoaControlRequestReservation = 'reserved' | 'in_progress' | 'completed' | 'mismatched'

/**
 * A retry with the exact request id/body returns the already-completed
 * aggregate rather than replaying a mutation. A concurrent duplicate remains
 * in progress, while a request-id/body mismatch is refused as tampering.
 */
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
): Promise<UoaControlRequestReservation> => {
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
    return 'reserved'
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      const existing = await ledger.findUnique({
        where: { requestId: input.requestId },
        select: { requestDigest: true, completedAt: true },
      })
      if (!existing || existing.requestDigest !== input.requestDigest) return 'mismatched'
      return existing.completedAt ? 'completed' : 'in_progress'
    }
    throw error
  }
}

export const completeUoaAutomaticMembershipControlRequest = async (
  ledger: ControlRequestLedger,
  requestId: string,
  now = new Date(),
): Promise<void> => {
  await ledger.update({ where: { requestId }, data: { completedAt: now } })
}
