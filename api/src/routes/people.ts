import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  isAdminActor,
  PeopleQuerySchema,
  type AuthorizedActionContext,
  type LocalRosterPermissions,
  type PeopleQuery,
  type ProviderPerson,
} from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  findOrganizationTeam,
  isLocalTeamMember,
  listBoundOrganizationTeams,
  listLocalOrganizationPeople,
  listLocalTeamPeople,
  type OrganizationTeam,
} from '../services/people-roster.js'
import {
  listOrganisationMembers,
  listTeamMembers,
  resolveLocalUserIdsByUoaSub,
  withUoaOrgRosterSubjectAssertion,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import {
  uoaTeamMembershipDirectory,
  type UoaTeamMembershipDirectory,
} from '../services/uoa-team-memberships.js'
import { sendMemberManagementError } from './member-management-errors.js'
import { requireOrganizationAdministrator } from './organization-roster-access.js'
import type { RouteDeps } from './types.js'

/**
 * `GET /api/people[?team=<id>]` — the people read model behind Admin › People
 * (plan §10.4): the organisation's roster with each person's teams and role,
 * or one team's roster with each person's role in it.
 *
 * **Which source is decided by the organisation's binding, never by the
 * deployment mode or the session** (`docs/standards/team-model.md`). On an
 * organisation bound to the sign-in provider the roster is the provider's,
 * relayed with the caller's own subject assertion so the provider authorises
 * the exact organisation or team, and nothing is stored: each person's teams
 * are read from the organisation's team rosters and held in process memory
 * for seconds (`uoa-team-memberships.ts`). On an unbound install the roster is
 * the install's own rows.
 *
 * **Who may read what.** The organisation's roster answers the organisation's
 * administrators: the provider's live standing on a bound organisation, a local
 * owner or admin on an unbound one. A team's roster answers anybody the
 * provider lets read that team (bound), or the team's own members and the
 * organisation's owners and admins (unbound). Writes stay where they were —
 * the member routes, which authorise each target as before.
 */

type PeopleRouteDeps = Pick<RouteDeps, 'prisma' | 'requireActorContext'>

const pageQuery = (query: PeopleQuery) => ({
  ...(query.cursor ? { cursor: query.cursor } : {}),
  ...(query.direction ? { direction: query.direction } : {}),
  ...(query.limit ? { limit: query.limit } : {}),
})

/** What a local roster lets its caller do: every local membership write is the owner's. */
const localPermissions = (
  actorContext: AuthorizedActionContext,
  scope: 'organization' | 'team',
): LocalRosterPermissions => {
  const owner = actorContext.actor.roles?.includes('owner') === true
  return {
    addMember: owner && scope === 'organization',
    addToTeam: owner && scope === 'team',
    changeActivation: owner && scope === 'organization',
    changeRole: owner && scope === 'organization',
  }
}

export const registerPeopleRoutes = (
  app: FastifyInstance,
  deps: PeopleRouteDeps,
  rosterDeps: UoaRosterDeps = {},
  memberships: UoaTeamMembershipDirectory = uoaTeamMembershipDirectory,
): void => {
  const { prisma, requireActorContext } = deps

  const providerRoster = async (
    reply: FastifyReply,
    actorContext: AuthorizedActionContext,
    externalOrgId: string,
    query: PeopleQuery,
    team: OrganizationTeam | null,
  ) => {
    const identity = actorContext.actionContext.uoaIdentity
    const organizationId = actorContext.tenant.organizationId
    const status = query.status ?? 'ACTIVE'
    const withLocalIds = async (items: ProviderPerson[]): Promise<ProviderPerson[]> => {
      const localIdBySub = await resolveLocalUserIdsByUoaSub(
        prisma,
        organizationId,
        items.map((member) => member.uoaSub),
      )
      return items.map((member) => {
        const userId = localIdBySub.get(member.uoaSub)
        return userId ? { ...member, userId } : member
      })
    }

    if (team) {
      if (!team.externalTeamId || team.externalOrgId !== externalOrgId) {
        sendApiError(reply, 404, 'TEAM_NOT_LINKED', "This team isn't connected to UnlikeOtherAI.")
        return reply
      }
      const target = { externalOrgId, externalTeamId: team.externalTeamId }
      const page = await listTeamMembers(
        target,
        { status, ...pageQuery(query) },
        withUoaRosterSubjectAssertion(target, identity, rosterDeps),
      )
      return createApiResponse({
        items: await withLocalIds(page.items),
        permissions: page.permissions,
        source: 'provider' as const,
        team: { id: team.id, name: team.name },
      }, page.meta)
    }

    if (!(await requireOrganizationAdministrator(actorContext, externalOrgId, reply, rosterDeps))) {
      return reply
    }
    const page = await listOrganisationMembers(
      externalOrgId,
      { status, ...pageQuery(query) },
      withUoaOrgRosterSubjectAssertion(externalOrgId, identity, rosterDeps),
    )
    const teamsBySubject = identity
      ? await memberships.membershipsBySubject({
          externalOrgId,
          identity,
          teams: await listBoundOrganizationTeams(prisma, organizationId),
        })
      : new Map()
    const items = await withLocalIds(page.items)
    return createApiResponse({
      items: items.map((member) => ({ ...member, teams: teamsBySubject.get(member.uoaSub) ?? [] })),
      permissions: page.permissions,
      source: 'provider' as const,
    }, page.meta)
  }

  const localRoster = async (
    reply: FastifyReply,
    actorContext: AuthorizedActionContext,
    query: PeopleQuery,
    team: OrganizationTeam | null,
  ) => {
    const organizationId = actorContext.tenant.organizationId
    const status = query.status ?? 'ACTIVE'
    if (team) {
      const allowed = isAdminActor(actorContext)
        || await isLocalTeamMember(prisma, team.id, actorContext.actor.actorId)
      if (!allowed) {
        sendApiError(
          reply,
          403,
          'TEAM_MEMBERSHIP_REQUIRED',
          'Only people in this team, and organisation owners and admins, see who is in it.',
        )
        return reply
      }
      const page = await listLocalTeamPeople(prisma, organizationId, team.id, { status, ...pageQuery(query) })
      return createApiResponse({
        items: page.items,
        permissions: localPermissions(actorContext, 'team'),
        source: 'local' as const,
        team: { id: team.id, name: team.name },
      }, page.meta)
    }

    if (!isAdminActor(actorContext)) {
      sendApiError(reply, 403, 'ORGANIZATION_ADMIN_REQUIRED', 'Only organisation owners and admins see everyone in it.')
      return reply
    }
    const page = await listLocalOrganizationPeople(prisma, organizationId, { status, ...pageQuery(query) })
    return createApiResponse({
      items: page.items,
      permissions: localPermissions(actorContext, 'organization'),
      source: 'local' as const,
    }, page.meta)
  }

  app.get('/api/people', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(PeopleQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply

    const organizationId = actorContext.tenant.organizationId
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { externalOrgId: true },
    })
    if (!organization) {
      sendApiError(reply, 404, 'ORGANIZATION_NOT_FOUND', 'Organization not found')
      return reply
    }
    // A named team must be one of this organisation's own — never a system
    // team, never another organisation's, and never a fall-back to the team
    // the session is working in.
    const team = query.team ? await findOrganizationTeam(prisma, organizationId, query.team) : null
    if (query.team && !team) {
      sendApiError(reply, 404, 'TEAM_NOT_FOUND', "This team isn't in your organisation.")
      return reply
    }

    try {
      return organization.externalOrgId
        ? await providerRoster(reply, actorContext, organization.externalOrgId, query, team)
        : await localRoster(reply, actorContext, query, team)
    } catch (error) {
      if (sendMemberManagementError(request, reply, error, team ? 'team' : 'organization')) return reply
      throw error
    }
  })
}
