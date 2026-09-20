import { Prisma, type PrismaClient } from '@prisma/client'

export const runWithDeepWaterTransitionLock = <T>(
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string },
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => prisma.$transaction(async (tx) => {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.teamId}:deep-water`}, 0))`)
  return action(tx)
})
