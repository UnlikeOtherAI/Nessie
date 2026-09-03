import type { PrismaClient } from '@prisma/client'
import {
  channelTeamInclude,
  ensureGlobalAgentBootstrap,
  getGlobalAgentBlueprint,
  mapChannelRecord,
} from '@nessie/team-admin'
import type { ChannelRecord } from '@nessie/schemas'

/**
 * Resolve one person's home DM with a global agent, provisioning it if it is
 * missing.
 *
 * Login-time bootstrap is deliberately best-effort — a blueprint problem must
 * never lock somebody out — so a doorway that merely assumes the channel is
 * already there is a doorway that silently fails for exactly the people whose
 * bootstrap did not run. Ensuring here is idempotent and advisory-locked, which
 * is what lets every client (web, desktop, phone) treat "open the Agent
 * Designer" as one call rather than a lookup with a fallback each reimplements.
 */
export const openGlobalAgentHome = async (
  prisma: PrismaClient,
  input: { organizationId: string; slug: string; teamId: string; userId: string },
): Promise<{ agentId: string; channel: ChannelRecord; threadId: string } | null> => {
  const blueprint = getGlobalAgentBlueprint(input.slug)
  if (!blueprint) return null

  const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
    blueprint,
    organizationId: input.organizationId,
    teamId: input.teamId,
    userId: input.userId,
  })

  const channel = await prisma.channel.findUniqueOrThrow({
    where: { id: bootstrap.channelId },
    include: channelTeamInclude,
  })

  return {
    agentId: bootstrap.agentId,
    channel: await mapChannelRecord(prisma, channel, input.userId),
    threadId: bootstrap.threadId,
  }
}
