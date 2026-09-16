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
 * 1. The channel must be visible to the caller: a live `ChannelMember` row, or
 *    an organisation admin on a standard non-system non-DM channel in this
 *    organisation. Public channels the viewer has never joined are still
 *    refused by the route for agent management, so they are refused here.
 * 2. no `systemChannelType` — every system DM is a single-agent surface and
 *    the routes refuse all of them, not only the Personal Assistant's.
 * 3. `requireAdminActor` — the organisation owner or admin role.
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
  prisma: Pick<PrismaClient, 'channelMember' | 'organizationMember'>,
  input: {
    channel: { id: string; organizationId: string; systemChannelType: string | null; type: string }
    /** Known from the request's live roles; read from the row when omitted. */
    isOrganizationAdmin?: boolean
    /** Already-loaded membership, when the caller has it. */
    isChannelMember?: boolean
    userId: string
  },
): Promise<boolean> => {
  if (input.channel.systemChannelType) return false
  if (input.channel.type !== 'standard') return false

  const isAdmin = input.isOrganizationAdmin
    ?? isAdminRole(
      (await prisma.organizationMember.findFirst({
        where: { organizationId: input.channel.organizationId, userId: input.userId },
        select: { role: true },
      }))?.role,
    )
  if (!isAdmin) return false

  if (input.isChannelMember !== undefined) return input.isChannelMember
  return (await prisma.channelMember.count({
    where: { channelId: input.channel.id, userId: input.userId },
  })) > 0
}
