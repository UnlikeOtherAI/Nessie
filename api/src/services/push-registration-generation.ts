import type { PrismaClient } from '@prisma/client'

/**
 * Allocate the next server-owned ordering value for a physical-device handoff.
 *
 * This is global by design: a former account's stale session must sort before
 * the next account's registration for the same installation.
 */
export const nextPushRegistrationGeneration = async (
  prisma: Pick<PrismaClient, 'pushRegistrationGeneration'>,
): Promise<bigint> => {
  const generation = await prisma.pushRegistrationGeneration.upsert({
    where: { id: 1 },
    create: { id: 1, value: 1n },
    update: { value: { increment: 1n } },
    select: { value: true },
  })
  return generation.value
}
