import type { PrismaClient } from '@prisma/client'
import {
  AGENT_EDIT_AUTHORITY_ERROR_CODES,
  resolveAgentEditAuthority,
  type AgentEditAuthorityErrorCode,
} from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

/**
 * Deleting an agent.
 *
 * It is a **soft** delete, and that is not a hedge. An agent carries audit
 * history — runs, messages, approvals, tasks, ledger entries — and removing the
 * row would take that history with it. Three foreign keys are
 * `onDelete: Restrict` (`ExecutorPrivateAssignment`,
 * `ExecutorAgentOperationGrant`, `ExecutorAvailabilityCandidate`) and
 * `AgentBrowser` is `NoAction`, so a hard delete would fail regardless of the
 * order it was attempted in. There is no hard delete to fall back to.
 *
 * Keeping the row is therefore the easy half. The hard half is that **every
 * live capability must be revoked in the same transaction**, because a row that
 * still exists is a row that still works: a binding would keep waking the agent
 * in a channel, a trigger would keep firing, a tool grant would keep
 * authorising. A soft delete that only sets a timestamp is a deleted agent that
 * carries on working, which is worse than no delete at all.
 */

export type DeleteAgentResult =
  | { kind: 'deleted'; agentId: string }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: AgentEditAuthorityErrorCode; message: string }

export const deleteAgent = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  agentId: string,
): Promise<DeleteAgentResult> => {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, organizationId: actorContext.tenant.organizationId },
    select: {
      deletedAt: true,
      id: true,
      organizationId: true,
      ownerUserId: true,
      systemManaged: true,
      visibility: true,
    },
  })
  // An already-deleted agent is indistinguishable from one that never existed:
  // the delete is idempotent from the caller's point of view and discloses
  // nothing about what used to be here.
  if (!agent || agent.deletedAt) return { kind: 'not_found' }

  const authority = await resolveAgentEditAuthority(
    prisma,
    {
      organizationId: actorContext.tenant.organizationId,
      ...(actorContext.actionContext.uoaIdentity
        ? { uoaIdentity: actorContext.actionContext.uoaIdentity }
        : {}),
      userId: actorContext.actor.actorId,
    },
    agent,
  )
  if (!authority.canEdit) {
    const refusal = authority.refusal ?? {
      code: AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED,
      message: 'You cannot change this agent.',
    }
    return { kind: 'refused', ...refusal }
  }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agent.id }, data: { deletedAt: now } })

    // 1. Bindings — the agent stops being a participant anywhere.
    await tx.agentBinding.deleteMany({ where: { agentId: agent.id } })

    // 2. Triggers — nothing schedules or wakes it again.
    await tx.agentTrigger.deleteMany({ where: { agentId: agent.id } })

    // 3. Runs. A queued or suspended run is flipped straight to `cancelled`; it
    //    has not executed and never will. A `running` run gets the cooperative
    //    cancel flag instead, which the agentic loop observes and terminalizes
    //    itself — writing `cancelled` under a loop that is mid-iteration would
    //    race its own completion write and lose the run's partial output.
    //
    //    Deliberately NOT routed through `requestRunCancellation`: that service
    //    resolves each run through `loadRunForActor`, which is scoped by
    //    CHANNEL membership. An organisation admin deleting an agent with an
    //    in-flight run in a protected room they never joined would be told the
    //    run does not exist, and the run would survive the delete. Authority to
    //    delete the agent is strictly stronger than authority to read one of
    //    its runs, so the scope here is the agent and its organisation.
    await tx.run.updateMany({
      where: {
        agentId: agent.id,
        status: { in: ['pending', 'waiting_approval', 'waiting_input'] },
      },
      data: {
        status: 'cancelled',
        finishedAt: now,
        cancelRequestedAt: now,
        cancelRequestedByUserId: actorContext.actor.actorId,
      },
    })
    await tx.run.updateMany({
      where: { agentId: agent.id, status: 'running', cancelRequestedAt: null },
      data: { cancelRequestedAt: now, cancelRequestedByUserId: actorContext.actor.actorId },
    })

    // 4. The auto-created "<name> — Documents" space. Its FK is
    //    `onDelete: NoAction`, and the pages are the project's work rather than
    //    the agent's, so the space is detached and left in place instead of
    //    being removed with its contents.
    await tx.knowledgeSpace.updateMany({
      where: { ownerAgentId: agent.id },
      data: { ownerAgentId: null },
    })

    // 5. The mailbox is soft-deleted, and its address is HELD rather than
    //    released. `AgentMailbox.agentId` is `@unique` and non-null, so
    //    re-binding the address to a different agent would let mail sent to a
    //    person's old agent silently reach a new one. Reuse can be a later,
    //    deliberate feature; it is not a side effect of a delete.
    await tx.agentMailbox.updateMany({
      where: { agentId: agent.id },
      data: { deletedAt: now },
    })

    // 6. Grants. Each of these is a standing permission that would otherwise
    //    keep authorising work for a row that is supposed to be gone.
    await tx.sendAuthorizationGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.toolGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.executorAgentOperationGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.browserPersonalAccessGrant.deleteMany({ where: { agentId: agent.id } })
    await tx.mailboxConnectionAgentAccess.deleteMany({ where: { agentId: agent.id } })

    // Child agents keep `parentAgentId` pointing here, and core documents stay
    // intact: both are audit trail, which the soft delete exists to preserve.
  })

  return { kind: 'deleted', agentId: agent.id }
}
