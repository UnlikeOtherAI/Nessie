import type { PrismaClient } from '@prisma/client'
import { isAdminRole } from '@nessie/schemas'

/**
 * "May this person add or remove an agent in this channel?"
 *
 * One definition, because two producers of `ChannelRecord` answer it — the
 * single-record `mapChannelRecord` and the batched `listChannelsForUser` — and
 * a client draws the control from whichever one it happened to read. It is a
 * different question from `canModifyChannel`: adding a *person* is any member
 * of the channel, while `POST` and `DELETE /api/agents/:agentId/bindings`
 * require an organisation OWNER or ADMIN who can see the channel, and never
 * apply to a system channel.
 *
 * It mirrors those routes' pre-policy gate, in their order:
 *
 * 1. `type === 'standard'` with no `systemChannelType` — every system DM is a
 *    single-agent surface and the routes refuse all of them, not only the
 *    Personal Assistant's, and a direct message (group or not) is somebody's
 *    private conversation that no organisation role reaches into.
 * 2. `requireAdminActor` — the organisation owner or admin role.
 *
 * Channel membership is deliberately NOT a third condition. Management is not
 * participation (`docs/standards/team-model.md`): an organisation admin may
 * place an agent in a standard room without joining it, and adding one must not
 * quietly make them a member. An admin standing alone therefore decides this,
 * and every standard non-system channel in their organisation is one they may
 * already see — public by browse, protected by direct URL or admin tooling.
 *
 * The routes then run `checkPolicy('agent', 'bind')`, which is deliberately
 * NOT reproduced here. That check resolves rules an organisation may scope to
 * a project, a team, a channel, an agent or one person, and its seeded default
 * already allows exactly the owners/admins this predicate admits. Reproducing
 * it per channel would either duplicate the scope chain or answer a question
 * the popup does not ask (it offers many agents, and a rule may name one), so
 * a tightened policy stays what it is — a refusal the person is told about —
 * rather than a control that quietly disappears for the people the default
 * rules allow.
 */
export const canManageChannelAgents = async (
  prisma: Pick<PrismaClient, 'organizationMember'>,
  input: {
    channel: { organizationId: string; systemChannelType: string | null; type: string }
    /** Known from the request's live roles; read from the row when omitted. */
    isOrganizationAdmin?: boolean
    userId: string
  },
): Promise<boolean> => {
  if (input.channel.systemChannelType) return false
  if (input.channel.type !== 'standard') return false

  return input.isOrganizationAdmin
    ?? isAdminRole(
      (await prisma.organizationMember.findFirst({
        where: { organizationId: input.channel.organizationId, userId: input.userId },
        select: { role: true },
      }))?.role,
    )
}
