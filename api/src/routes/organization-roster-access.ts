import type { FastifyReply } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { sendApiError } from '../lib/api.js'
import { resolveOrganizationAdministrationAccess } from '../services/uoa-organization-administration.js'
import type { UoaRosterDeps } from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The two preconditions of every organisation-wide roster read and write on a
 * bound organisation — the member routes (`organization-members.ts`) and the
 * people read (`people.ts`) — stated once so they cannot drift apart.
 */

/** The tenant's provider organisation id, or a 404 when the organisation is not bound. */
export const resolveOrganizationExternalId = async (
  deps: Pick<RouteDeps, 'prisma'>,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): Promise<string | null> => {
  const organization = await deps.prisma.organization.findUnique({
    where: { id: actorContext.tenant.organizationId },
    select: { externalOrgId: true },
  })
  if (!organization?.externalOrgId) {
    sendApiError(
      reply,
      404,
      'ORGANIZATION_NOT_LINKED',
      "This organisation isn't connected to UnlikeOtherAI.",
    )
    return null
  }
  return organization.externalOrgId
}

/**
 * The organisation's roster is one capability, not a local-role convention:
 * the provider's live administration standing, read fresh for this request.
 */
export const requireOrganizationAdministrator = async (
  actorContext: AuthorizedActionContext,
  externalOrgId: string,
  reply: FastifyReply,
  rosterDeps: UoaRosterDeps,
): Promise<boolean> => {
  const access = await resolveOrganizationAdministrationAccess(
    { actorContext, organization: { externalOrgId } },
    rosterDeps,
  )
  if (access.status === 'allowed') return true
  if (access.status === 'unavailable') {
    sendApiError(
      reply,
      503,
      'UOA_ORGANIZATION_ACCESS_UNAVAILABLE',
      "We couldn't check whether you're an organisation admin. Try again in a moment.",
    )
    return false
  }
  sendApiError(
    reply,
    403,
    'ORGANIZATION_ADMIN_REQUIRED',
    'Only organisation admins can do this.',
  )
  return false
}
