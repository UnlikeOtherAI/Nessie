import type { Prisma } from '@prisma/client'
import { writeAuditEntryInTransaction } from '@nessie/db'

type TransactionClient = Prisma.TransactionClient

/**
 * A private agent has no audience when its sole owner is deactivated. This is
 * intentionally unlike workspace-agent stewardship: only private triggers are
 * paused, and reactivation deliberately leaves them paused for an explicit
 * human re-enable.
 */
export const pausePrivateAgentsForDeactivatedOwner = async (
  tx: TransactionClient,
  input: {
    actorUserId: string
    organizationId: string
    requestId: string
    userId: string
  },
): Promise<void> => {
  const agents = await tx.agent.findMany({
    where: {
      organizationId: input.organizationId,
      ownerUserId: input.userId,
      visibility: 'private',
    },
    select: { id: true },
  })

  if (agents.length === 0) return

  const paused = await tx.agentTrigger.updateMany({
    where: {
      agentId: { in: agents.map((agent) => agent.id) },
      enabled: true,
    },
    data: {
      enabled: false,
      healthDetail: 'The private agent owner is no longer an active member.',
      healthReason: 'private_agent_owner_deactivated',
      healthRevision: { increment: 1 },
      nextRunAt: null,
      status: 'paused',
    },
  })

  // Membership deactivation removes the private agent's only audience. There
  // is therefore no honest user_alert recipient: widening the notification to
  // an org owner would disclose the private agent. The audit row is the single
  // durable transition signal and records only aggregate counts.
  await writeAuditEntryInTransaction(tx, {
    action: 'agent.private.paused_owner_deactivated',
    actorId: input.actorUserId,
    actorType: 'user',
    channelId: null,
    ipAddress: null,
    metadata: {
      pausedPrivateAgentCount: agents.length,
      pausedTriggerCount: paused.count,
    },
    organizationId: input.organizationId,
    outcome: 'success',
    projectId: null,
    reason: 'private_agent_owner_deactivated',
    requestId: input.requestId,
    resourceId: input.userId,
    resourceType: 'organization_member',
    teamId: null,
    userAgent: null,
  })
}
