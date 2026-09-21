import { createHash, createHmac, createPublicKey, verify } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  ExecutorPairingStartPayloadSchema,
  type ExecutorPairingStartRequest,
} from '@nessie/schemas'
import { canonicalExecutorJson, canonicalExecutorPayload } from './executor-canonical-json.js'
import { ExecutorError, EXECUTOR_ERROR_CODES } from './executor-errors.js'

export const pairingDigest = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`
export function pairingUnavailable(): never {
  throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_USED, 'This pairing is no longer available.')
}
export const assertPairingProof = (
  machinePublicKey: string, domain: string, payload: unknown, signature: string,
): void => {
  const raw = Buffer.from(machinePublicKey, 'base64url')
  if (raw.length !== 32 || raw.toString('base64url') !== machinePublicKey) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID, 'Machine proof is invalid.')
  }
  const publicKey = createPublicKey({
    format: 'der', type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
  })
  if (!verify(null, Buffer.from(canonicalExecutorPayload(domain, payload)), publicKey, Buffer.from(signature, 'base64url'))) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID, 'Machine proof is invalid.')
  }
}
export const assertPairingTimestamp = (timestamp: string, now: Date): void => {
  if (Math.abs(now.getTime() - new Date(timestamp).getTime()) > 60_000) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ENROLLMENT_PROOF_INVALID, 'Machine request has expired.')
  }
}
export const pairingStartPayload = (input: ExecutorPairingStartRequest) => {
  return ExecutorPairingStartPayloadSchema.strip().parse(input)
}
export const pairingRequestDigest = (input: ExecutorPairingStartRequest): string => {
  const facts = ExecutorPairingStartPayloadSchema.omit({ timestamp: true }).strip().parse(input)
  return pairingDigest(canonicalExecutorJson(facts))
}
// A keyed derivation allows response-loss retries without retaining plaintext
// codes. Rejection sampling avoids modulo bias in the decimal space.
export const pairingCode = (secret: string, id: string, codeNonce = 0): string => {
  for (let nonce = 0; ; nonce += 1) {
    const value = createHmac('sha256', secret)
      .update(`nessie.executor.pairing.code.v1\n${id}\n${codeNonce}\n${nonce}`).digest().readUInt32BE()
    if (value < 4_200_000_000) return (value % 100_000_000).toString().padStart(8, '0')
  }
}
export const pairingCodeVerifier = (secret: string, code: string): string =>
  createHmac('sha256', secret).update(`nessie.executor.pairing.lookup.v1\n${code}`).digest('hex')
export const lockPairing = async (tx: Prisma.TransactionClient, id: string): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`executor-pairing:${id}`}, 0))`)
}
export const revokePairingExecutor = async (tx: Prisma.TransactionClient, executorId: string): Promise<void> => {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${executorId}`}, 0))`)
  await tx.executor.update({ where: { id: executorId }, data: {
    status: 'revoked', statusDetail: 'Pairing was closed on this machine.',
    authorizationRevision: { increment: 1 }, activeConnectionEpoch: { increment: 1 },
  } })
  await tx.executorSession.updateMany({
    where: { executorId, status: { in: ['pending', 'active'] } }, data: { status: 'stopped' },
  })
}
