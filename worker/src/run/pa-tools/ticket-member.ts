import type { AgentTaskActor } from '@nessie/team-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { isTicketWorkRun } from '../execute/ticket-work-setup.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { resolveActingMember, type ActingMember } from './access.js'

/**
 * Who a ticket tool acts as (docs/standards/ticket-work.md → "A `ticket.work`
 * run acts as the agent").
 *
 * On every run a person is behind, the acting member: the person, their live
 * role, their project access (`resolveActingMember`). On a `ticket.work` run
 * there is no person to act as, and the run must never reconstruct one — not
 * the mover, not the trigger's author — so the member is the agent itself. Its
 * reach is its live binding to the run's project channel (`projectFor`), and
 * the shared ticket functions take it as an `AgentTaskActor`, which writes
 * `agent:<id>` with the run. It is never routed through `requireActingUserId`.
 *
 * Only the tools that can act this way resolve a `TicketMember`
 * (`TICKET_WORK_PROJECT_TOOL_IDS`); every other ticket tool still resolves
 * the acting member, and so refuses a run with no person behind it.
 */
export type AgentTicketMember = {
  userId: null
  agentId: string
  organizationId: string
  isOwner: false
  isOrganizationAdmin: false
  actorContext: AuthorizedActionContext
}

export type TicketMember = ActingMember | AgentTicketMember

export const resolveTicketMember = async (context: BuiltinToolRuntimeContext): Promise<TicketMember> =>
  isTicketWorkRun(context.actorContext)
    ? {
        userId: null,
        agentId: context.agentId,
        organizationId: context.channel.organizationId,
        isOwner: false,
        isOrganizationAdmin: false,
        actorContext: context.actorContext,
      }
    : resolveActingMember(context)

/** The shared ticket functions' actor for an agent with no person behind it. */
export const agentTaskActorFor = (
  context: BuiltinToolRuntimeContext,
  member: AgentTicketMember,
): AgentTaskActor => ({
  organizationId: member.organizationId,
  userId: null,
  isOrganizationAdmin: false,
  agentId: member.agentId,
  unattended: true,
  origin: { kind: 'agent', agentId: member.agentId, runId: context.run.id },
})
