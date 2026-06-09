import type { PrismaClient } from '@prisma/client'

const DEFAULT_ACTIVE_WITHIN_MS = 30_000

type PresencePrisma = Pick<PrismaClient, 'userPresence'>

export const markConnected = async (
  prisma: PresencePrisma,
  userId: string,
  organizationId: string,
): Promise<void> => {
  const now = new Date()
  await prisma.userPresence.upsert({
    where: { userId },
    create: {
      userId,
      organizationId,
      connections: 1,
      lastSeenAt: now,
    },
    update: {
      organizationId,
      connections: { increment: 1 },
      lastSeenAt: now,
    },
  })
}

export const markDisconnected = async (
  prisma: PresencePrisma,
  userId: string,
): Promise<void> => {
  await prisma.userPresence.updateMany({
    where: {
      userId,
      connections: { gt: 0 },
    },
    data: {
      connections: { decrement: 1 },
    },
  })
}

export const touch = async (
  prisma: PresencePrisma,
  userId: string,
): Promise<void> => {
  await prisma.userPresence.updateMany({
    where: { userId },
    data: { lastSeenAt: new Date() },
  })
}

export const isUserActive = async (
  prisma: PresencePrisma,
  userId: string,
  withinMs = DEFAULT_ACTIVE_WITHIN_MS,
): Promise<boolean> => {
  const activePresence = await prisma.userPresence.findFirst({
    where: {
      userId,
      connections: { gt: 0 },
      lastSeenAt: { gte: new Date(Date.now() - withinMs) },
    },
    select: { userId: true },
  })

  return activePresence !== null
}
