import type { PrismaClient } from '@prisma/client'
import { isOwnerRole } from '@nessie/schemas'

/**
 * "May this person add or remove an agent in this channel?"
 *
 * One definition, because two producers of `ChannelRecord` answer it — the
 * single-record `mapChannelRecord` and the batched `listChannelsForUser` — and
 * a client draws the control from whichever one it happened to read. It is a
 * different question from `canModifyChannel`: adding a *person* is any member
 * of the channel, while `POST` and `DELETE /api/agents/:agentId/bindings`
 * require the organisation owner role on top of that membership.
 *
 * It mirrors those routes' pre-policy gate, in their order:
 *
 * 1. `getChannelIfMember` — a live `ChannelMember` row for this viewer, in
 *    this organisation, on a channel that is not soft-deleted. Note this is
 *    membership, not visibility: a public channel the viewer has never joined
 *    is refused by the route, so it is refused here.
 * 2. no `systemChannelType` — every system DM is a single-agent surface and
 *    the routes refuse all of them, not only the Personal Assistant's.
 * 3. `requireOwner` — the organisation owner role, not owner-or-admin.
 *
 * The routes then run `checkPolicy('agent', 'bind')`, which is deliberately
 * NOT reproduced here. That check resolves rules an organisation may scope to
 * a project, a team, a channel, an agent or one person, and its seeded default
 * already allows exactly the owners this predicate admits. Reproducing it per
 * channel would either duplicate the scope chain or answer a question the
 * popup does not ask (it offers many agents, and a rule may name one), so a
 * tightened policy stays what it is — a refusal the person is told about —
 * rather than a control that quietly disappears for the people the default
 * rules allow.
 */
export const canManageChannelAgents = async (
  prisma: Pick<PrismaClient, 'channelMember' | 'organizationMember'>,
  input: {
    channel: { id: string; organizationId: string; systemChannelType: string | null }
    /** Known from the request's live roles; read from the row when omitted. */
    isOrganizationOwner?: boolean
    /** Already-loaded membership, when the caller has it. */
    isChannelMember?: boolean
    userId: string
  },
): Promise<boolean> => {
  if (input.channel.systemChannelType) return false

  const isOwner = input.isOrganizationOwner
    ?? isOwnerRole(
      (await prisma.organizationMember.findFirst({
        where: { organizationId: input.channel.organizationId, userId: input.userId },
        select: { role: true },
      }))?.role,
    )
  if (!isOwner) return false

  if (input.isChannelMember !== undefined) return input.isChannelMember
  return (await prisma.channelMember.count({
    where: { channelId: input.channel.id, userId: input.userId },
  })) > 0
}
