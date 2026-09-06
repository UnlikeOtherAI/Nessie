import type { PrismaClient } from '@prisma/client'
import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'

/**
 * Org/project/team membership and roles are owned by the identity provider
 * wherever one binds the tenant being acted on: the local rows are a projection
 * of the verified session claims (`services/uoa-roles.ts`), and a local write
 * would be silently reverted — or, worse, survive as a second authority — at
 * the next login or token rotation. Refuse it instead of pretending it took.
 *
 * **The predicate is the acting tenant's binding, not the deployment mode.**
 * `config.mode` was a proxy for it that failed in both directions (2026-09-05
 * API review, FO2-2): `mode: 'local'` with an enabled `uoa` provider is a fully
 * working UOA deployment where local membership writes were still allowed, and
 * a `selfHosted` install with no providers — the unbound org-tenant
 * `docs/standards/team-model.md` says keeps local control — had membership
 * management refused outright. `Organization.externalOrgId === null` (and
 * `Team.externalTeamId === null` for a team write) is the question the
 * invariant actually asks.
 *
 * Placed after the owner check and before any body parse, so an unauthorized
 * caller learns nothing.
 *
 * `ChannelMember` is deliberately NOT covered — a channel is a Nessie product
 * concept, not a UOA roster.
 */

export type MembershipGatePrisma = Pick<PrismaClient, 'organization' | 'team'>

const refuse = (reply: FastifyReply): boolean => {
  sendApiError(
    reply,
    403,
    'LOCAL_MEMBERSHIP_MANAGEMENT_DISABLED',
    'Membership and roles are managed in your identity provider.',
  )
  return false
}

/**
 * Returns `true` when the caller may manage membership locally, i.e. when the
 * organisation — and, for a team write, the team — carries no external binding.
 *
 * A `teamId` that does not resolve inside this organisation is deliberately not
 * this gate's refusal: the handler's own `404 Team not found` is the better
 * answer, and it runs immediately after.
 */
export const requireUnboundMembershipManagement = async (
  prisma: MembershipGatePrisma,
  reply: FastifyReply,
  input: { organizationId: string; teamId?: string },
): Promise<boolean> => {
  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { externalOrgId: true },
  })
  if (organization?.externalOrgId) {
    return refuse(reply)
  }
  if (input.teamId) {
    const team = await prisma.team.findFirst({
      where: { id: input.teamId, project: { organizationId: input.organizationId } },
      select: { externalTeamId: true },
    })
    if (team?.externalTeamId) {
      return refuse(reply)
    }
  }
  return true
}
