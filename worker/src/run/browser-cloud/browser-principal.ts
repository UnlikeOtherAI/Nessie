import type { PrismaClient } from '@prisma/client'

/**
 * Whose browser a run is opening.
 *
 * A private ordinary agent always uses its owner's jar, including runs whose
 * binding has no `principalUserId`. A system-managed agent — the Personal
 * Assistant, every global agent — keeps one jar per person, so opening its
 * browser instead needs the requester. A run started by somebody carries them
 * as `principalUserId`; a global agent's run carries nobody, because that
 * column is the Personal Assistant's. For those, the person is the one member
 * of the agent's own DM home, which is a per-user channel by construction
 * (`globalAgentHomeDmKey`).
 *
 * Null means a workspace jar. A system-managed agent with no person is
 * refused rather than quietly reaching for a shared jar.
 */
export const resolveBrowserPrincipal = async (context: {
  agentId: string
  agentIdentity?: { visibility: 'team' | 'private'; ownerUserId: string | null }
  channel: { id: string; organizationId: string }
  prisma: PrismaClient
  run: { principalUserId?: string | null }
}): Promise<string | null> => {
  if (context.agentIdentity?.visibility === 'private' && context.agentIdentity.ownerUserId) {
    const agent = await context.prisma.agent.findFirst({
      where: { id: context.agentId, organizationId: context.channel.organizationId },
      select: { systemManaged: true },
    })
    if (!agent?.systemManaged) return context.agentIdentity.ownerUserId
  }
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
