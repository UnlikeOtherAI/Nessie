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

/**
 * What `POST` and `DELETE /api/agents/:agentId/bindings` need before they act:
 * the channel, and whether this caller may place an agent in it.
 *
 * It replaces `getChannelIfMember` at those two routes. That helper answers
 * *membership*, which was the old gate and is the wrong question now — an
 * organisation admin manages a room without joining it, and the route must not
 * join them to it as a side effect of adding an agent.
 *
 * The two refusals stay distinguishable, because they mean different things to
 * the person:
 *
 * - `not_found` — no such channel, another organisation's, soft-deleted, or one
 *   this caller may not manage agents in. The route answers `404`, never `403`:
 *   a 403 would confirm a room exists, and for a direct message the label alone
 *   discloses who is talking to whom.
 * - `system_managed` — a real channel the caller can see, but a single-agent
 *   system surface whose binding is owned by its bootstrap. Worth saying out
 *   loud as a `403`, because the answer is "not this room, ever", not "not
 *   you".
 */
export type ChannelAgentManagementOutcome =
  | { kind: 'ok'; channel: { id: string; systemChannelType: string | null; type: string } }
  | { kind: 'not_found' }
  | { kind: 'system_managed' }

export const loadChannelForAgentManagement = async (
  prisma: Pick<PrismaClient, 'channel' | 'channelMember' | 'organizationMember'>,
  input: {
    channelId: string
    organizationId: string
    /** Known from the request's live roles; read from the row when omitted. */
    isOrganizationAdmin?: boolean
    userId: string
  },
): Promise<ChannelAgentManagementOutcome> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: {
      deletedAt: true,
      dmKey: true,
      id: true,
      organizationId: true,
      systemChannelType: true,
      type: true,
      members: { where: { userId: input.userId }, select: { id: true }, take: 1 },
    },
  })
  if (!channel || channel.deletedAt || channel.organizationId !== input.organizationId) {
    return { kind: 'not_found' }
  }

  // Said before the authority check, and only to somebody already in the room:
  // to everybody else a system surface is simply not found, so the refusal
  // never becomes a way to probe which system channels exist.
  if (channel.systemChannelType) {
    return channel.members.length > 0 ? { kind: 'system_managed' } : { kind: 'not_found' }
  }

  const mayManage = await canManageChannelAgents(prisma, {
    channel: {
      organizationId: channel.organizationId,
      systemChannelType: channel.systemChannelType,
      type: channel.type,
    },
    ...(input.isOrganizationAdmin === undefined
      ? {}
      : { isOrganizationAdmin: input.isOrganizationAdmin }),
    userId: input.userId,
  })
  if (!mayManage) return { kind: 'not_found' }

  return {
    kind: 'ok',
    channel: { id: channel.id, systemChannelType: channel.systemChannelType, type: channel.type },
  }
}
