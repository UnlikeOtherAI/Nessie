import type { PrismaClient } from '@prisma/client'

/**
 * Whose browser a run is opening.
 *
 * A system-managed agent — the Personal Assistant, every global agent — keeps
 * one cookie jar per person, so opening its browser needs to know which person.
 * A run started by somebody carries them as `principalUserId`; a global agent's
 * run carries nobody, because that column is the Personal Assistant's. For
 * those, the person is the one member of the agent's own DM home, which is a
 * per-user channel by construction (`globalAgentHomeDmKey`).
 *
 * Null means there is genuinely nobody — an unattended schedule — and
 * `ensureAgentBrowser` refuses rather than quietly reaching for a shared jar.
 */
export const resolveBrowserPrincipal = async (context: {
  channel: { id: string }
  prisma: PrismaClient
  run: { principalUserId?: string | null }
}): Promise<string | null> => {
  if (context.run.principalUserId) return context.run.principalUserId
  const members = await context.prisma.channelMember.findMany({
    where: { channelId: context.channel.id },
    select: { userId: true },
    take: 2,
  })
  // Exactly one, or it is not a personal home and there is no principal to
  // infer — better no browser than the wrong person's.
  return members.length === 1 ? members[0]?.userId ?? null : null
}
