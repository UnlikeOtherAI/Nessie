/**
 * Who may configure automatic team access — the route guards, which own the
 * HTTP shape of a refusal (they take a `FastifyReply` and choose its status).
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §4.6.
 *
 * Two different objects, two different gates:
 *
 *  - A **domain claim** is organisation owner/admin only. A verified domain
 *    takes an instance-wide exclusivity lock, so claiming one is an
 *    organisation-level act and a team admin must not be able to take it.
 *  - A **grant rule** — "this domain also grants team T" — is manageable by an
 *    organisation admin for any team, and by a team's own owners/admins for
 *    that team only.
 *
 * The team gate asks UOA rather than the local `TeamMember.role` projection.
 * `listTeamMembers` returns UOA's live `permissions.addMember` for the calling
 * subject on that exact team, which is precisely the question being asked —
 * "may this person put someone on this team?" — decided by the authority that
 * owns membership. Reading the local projection instead would make Nessie a
 * second authority over team roles, which is the defect
 * `docs/plans/2026-09-02-uoa-as-a-service-unification.md` is working to remove.
 */

import type { FastifyReply } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { sendApiError } from '../lib/api.js'
import {
  listTeamMembers,
  resolveUoaRosterTeam,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from '../services/uoa-org-roster.js'
import { resolveOrganizationAdministrationAccess } from '../services/uoa-organization-administration.js'
import type { RuleAuthorization } from '../services/automatic-membership/rules.js'
import type { RouteDeps } from './types.js'

/** The tenant's UOA organisation id, or a 404 that reveals nothing else. */
export const resolveExternalOrgId = async (
  deps: RouteDeps,
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
      'This organisation is not linked to an UnlikeOtherAI organisation.',
    )
    return null
  }
  return organization.externalOrgId
}

/** Organisation owner/admin, decided by UOA for a UOA-bound organisation. */
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
      'UnlikeOtherAI could not confirm organisation administrator access. Try again shortly.',
    )
    return false
  }
  sendApiError(
    reply,
    403,
    'ORGANIZATION_ADMIN_REQUIRED',
    'Organisation administrator access is required.',
  )
  return false
}

/**
 * Ask UOA whether this caller may add members to this exact team. Returns
 * `null` when the team is not UOA-bound or the relay is unavailable, so the
 * caller can answer 404/503 rather than guessing.
 */
export const canAdministerTeam = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  teamId: string,
  rosterDeps: UoaRosterDeps,
): Promise<{ team: UoaRosterTeam; allowed: boolean } | 'unbound' | 'unavailable'> => {
  const team = await resolveUoaRosterTeam(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId,
  })
  if (!team) return 'unbound'
  try {
    const page = await listTeamMembers(
      team,
      { limit: 1 },
      withUoaRosterSubjectAssertion(team, actorContext.actionContext.uoaIdentity, rosterDeps),
    )
    return { allowed: page.permissions.addMember === true, team }
  } catch (error) {
    if (error instanceof UoaRosterRejectedError) return { allowed: false, team }
    if (error instanceof UoaRosterIdentityError) return { allowed: false, team }
    if (error instanceof UoaRosterUnavailableError) return 'unavailable'
    throw error
  }
}

/**
 * The team surface's gate. Answers the reply and returns null on refusal, so a
 * route reads `const team = await requireTeamAdministrator(...); if (!team) return reply`.
 */
export const requireTeamAdministrator = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  teamId: string,
  reply: FastifyReply,
  rosterDeps: UoaRosterDeps,
): Promise<UoaRosterTeam | null> => {
  const verdict = await canAdministerTeam(deps, actorContext, teamId, rosterDeps)
  if (verdict === 'unbound') {
    sendApiError(reply, 404, 'TEAM_NOT_LINKED', 'This team is not linked to an UnlikeOtherAI team.')
    return null
  }
  if (verdict === 'unavailable') {
    sendApiError(
      reply,
      503,
      'UOA_ORGANIZATION_ACCESS_UNAVAILABLE',
      'UnlikeOtherAI could not confirm team administrator access. Try again shortly.',
    )
    return null
  }
  if (!verdict.allowed) {
    sendApiError(reply, 403, 'TEAM_ADMIN_REQUIRED', 'Team administrator access is required.')
    return null
  }
  return verdict.team
}

export const resolveRuleAuthorization = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): RuleAuthorization | null => {
  const identity = actorContext.actionContext.uoaIdentity
  if (!identity || identity.tokenVersion === null || identity.tokenVersion === undefined) {
    sendApiError(
      reply,
      403,
      'UOA_SESSION_REQUIRED',
      'Sign in with UnlikeOtherAI to configure automatic team access.',
    )
    return null
  }
  return {
    authorizedByUoaSub: identity.subject,
    authorizedTeamId: identity.teamId,
    authorizedTokenVersion: identity.tokenVersion,
  }
}
