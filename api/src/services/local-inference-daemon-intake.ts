import type { PrismaClient } from '@prisma/client'

import { verifyLocalInferenceEnvelope } from '@nessie/local-inference-host'

import { authorizeLocalInferenceDaemon, executorLocalInferenceDaemonStillAuthorized } from './local-inference-daemon-auth.js'

type Envelope = {
  connectionEpoch: string
  executorConnectionEpoch?: string
  hostId: string
  organizationId: string
  purpose: string
  sentAt: string
  sequence: number
}

export const authenticateLocalInferenceDaemonEnvelope = async (
  prisma: PrismaClient,
  input: { body: unknown; envelope: Envelope; purpose: 'control' | 'frames' | 'poll' | 'result' | 'goodbye' },
): Promise<{
  authorization: NonNullable<Awaited<ReturnType<typeof authorizeLocalInferenceDaemon>>>
  hostId: string
  stillAuthorized: (tx: Parameters<typeof executorLocalInferenceDaemonStillAuthorized>[0]) => Promise<boolean>
} | null> => {
  const authorization = await authorizeLocalInferenceDaemon(prisma, input.envelope)
  const host = authorization?.host
  const verified = authorization
    ? verifyLocalInferenceEnvelope({ body: input.body, envelope: input.envelope, machinePublicKey: authorization.machinePublicKey })
    : { ok: false as const }
  const sentAt = Date.parse(input.envelope.sentAt)
  if (!host || !authorization || !verified.ok || input.envelope.purpose !== input.purpose
    || !Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 30_000
    || BigInt(input.envelope.connectionEpoch) !== BigInt(host.connectionEpoch)) return null
  const accepted = await prisma.$transaction(async (tx) => {
    if (!await executorLocalInferenceDaemonStillAuthorized(tx, authorization)) return false
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-inference-host:${host.id}:${input.purpose}`}::text, 0))`
    const prior = await tx.localInferenceHostSequence.findUnique({
      where: { hostId_purpose: { hostId: host.id, purpose: input.purpose } }, select: { lastSequence: true },
    })
    if (prior && prior.lastSequence >= BigInt(input.envelope.sequence)) return false
    await tx.localInferenceHostSequence.upsert({
      where: { hostId_purpose: { hostId: host.id, purpose: input.purpose } },
      create: { hostId: host.id, lastSequence: BigInt(input.envelope.sequence), purpose: input.purpose },
      update: { lastSequence: BigInt(input.envelope.sequence) },
    })
    return true
  })
  return accepted
    ? { authorization, hostId: host.id, stillAuthorized: (tx) => executorLocalInferenceDaemonStillAuthorized(tx, authorization) }
    : null
}
