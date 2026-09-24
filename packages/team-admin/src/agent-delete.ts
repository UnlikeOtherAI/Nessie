import type { PrismaClient } from '@prisma/client'
import { AGENT_EDIT_AUTHORITY_ERROR_CODES, resolveAgentEditAuthority, type AgentEditAuthorityErrorCode } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { endTicketWorkForTrigger } from './ticket-trigger-teardown.js'

export type DeleteAgentResult =
  | { kind: 'deleted'; agentId: string }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: AgentEditAuthorityErrorCode; message: string }

/** Shared soft delete. The transaction revokes every standing way an agent can act. */
export const deleteAgent = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  agentId: string,
): Promise<DeleteAgentResult> => {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: actorContext.tenant.organizationId },
    select: {
      deletedAt: true, id: true, organizationId: true, ownerUserId: true,
      systemManaged: true, visibility: true,
    },
  })
  if (!agent || agent.deletedAt) return { kind: 'not_found' }
  const authority = await resolveAgentEditAuthority(prisma, {
    organizationId: actorContext.tenant.organizationId,
    ...(actorContext.actionContext.uoaIdentity
      ? { uoaIdentity: actorContext.actionContext.uoaIdentity }
      : {}),
    userId: actorContext.actor.actorId,
  }, agent)
  if (!authority.canEdit) return { kind: 'refused', ...(authority.refusal ?? { code: AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED, message: 'You cannot change this agent.' }) }
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agent.id }, data: { deletedAt: now } })
    await tx.agentBinding.deleteMany({ where: { agentId: agent.id } })
    // Its ticket triggers' work and machine access end before the triggers go,
    // while they still know which trigger held them.
    const ticketTriggers = await tx.agentTrigger.findMany({
      where: { agentId: agent.id, type: 'ticket_changed' },
      select: { id: true },
    })
    for (const trigger of ticketTriggers) {
      await endTicketWorkForTrigger(tx, {
        actor: { requestId: actorContext.actionContext.requestId, userId: actorContext.actor.actorId },
        reason: 'trigger_deleted',
        triggerId: trigger.id,
      })
    }
    await tx.agentTrigger.deleteMany({ where: { agentId: agent.id } })
    await tx.run.updateMany({ where: { agentId: agent.id, status: { in: ['pending', 'waiting_approval', 'waiting_input'] } }, data: { status: 'cancelled', finishedAt: now, cancelRequestedAt: now, cancelRequestedByUserId: actorContext.actor.actorId } })
    await tx.run.updateMany({ where: { agentId: agent.id, status: 'running', cancelRequestedAt: null }, data: { cancelRequestedAt: now, cancelRequestedByUserId: actorContext.actor.actorId } })
    await tx.knowledgeSpace.updateMany({ where: { ownerAgentId: agent.id }, data: { ownerAgentId: null } })
    await tx.agentMailbox.updateMany({ where: { agentId: agent.id }, data: { deletedAt: now } })
    await tx.sendAuthorizationGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.toolGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.executorAgentOperationGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.browserPersonalAccessGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.mailboxConnectionAgentAccess.deleteMany({ where: { agentId: agent.id } })
  })
  return { kind: 'deleted', agentId: agent.id }
}
