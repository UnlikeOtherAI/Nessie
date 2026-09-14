import type { PrismaClient } from '@prisma/client'

/** Bound one tenant/user's browser-enrollment fan-out without touching another tenant. */
export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER = 20

type WebPushSubscriptionPrisma = Pick<PrismaClient, 'webPushSubscription'>

export const trimWebPushSubscriptionCap = async (
  prisma: WebPushSubscriptionPrisma,
  scope: { organizationId: string; userId: string },
): Promise<void> => {
  const count = await prisma.webPushSubscription.count({ where: scope })
  if (count <= MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER) return

  const stale = await prisma.webPushSubscription.findMany({
    where: scope,
    orderBy: { lastSeenAt: 'asc' },
    take: count - MAX_WEB_PUSH_SUBSCRIPTIONS_PER_USER,
    select: { id: true },
  })
  await prisma.webPushSubscription.deleteMany({
    where: { ...scope, id: { in: stale.map((row) => row.id) } },
  })
}
