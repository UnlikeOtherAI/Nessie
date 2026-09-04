/* eslint-disable max-len -- route registration preserves one endpoint per lifecycle operation. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CreateAutomaticMembershipRuleSchema,
  UpdateAutomaticMembershipRuleSchema,
} from '@nessie/schemas'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'
import {
  activateAutomaticMembershipRule,
  AutomaticMembershipError,
  createAutomaticMembershipRule,
  DomainPolicyError,
  listAutomaticMembershipRules,
  revokeAutomaticMembershipRule,
  rotateAutomaticMembershipClaim,
  updateAutomaticMembershipRule,
  verifyAutomaticMembershipClaim,
} from '../services/automatic-membership.js'
import { resolveOrganizationAdministrationAccess } from '../services/uoa-organization-administration.js'
import {
  listTeamMembers,
  resolveUoaRosterTeam,
  withUoaRosterSubjectAssertion,
} from '../services/uoa-org-roster.js'

type Scope = 'organization' | 'team'

const sendServiceError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof AutomaticMembershipError || error instanceof DomainPolicyError) {
    return Boolean(sendApiError(reply, error instanceof AutomaticMembershipError ? error.statusCode : 400, error.code, error.message))
  }
  return false
}

const requireScopeAdministrator = async (
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: Scope,
): Promise<{ context: NonNullable<ReturnType<RouteDeps['requireActorContext']>>; teamId?: string } | null> => {
  const context = deps.requireActorContext(request, reply)
  if (!context) return null
  const organization = await deps.prisma.organization.findUnique({
    where: { id: context.tenant.organizationId }, select: { externalOrgId: true },
  })
  if (!organization?.externalOrgId) {
    sendApiError(reply, 404, 'ORGANIZATION_NOT_LINKED', 'Automatic logins require an UnlikeOtherAI organisation.')
    return null
  }
  if (scope === 'organization') {
    const access = await resolveOrganizationAdministrationAccess({ actorContext: context, organization })
    if (access.status === 'allowed') return { context }
    sendApiError(reply, access.status === 'unavailable' ? 503 : 403, access.status === 'unavailable' ? 'UOA_ORGANIZATION_ACCESS_UNAVAILABLE' : 'ORGANIZATION_ADMIN_REQUIRED', access.status === 'unavailable' ? 'UnlikeOtherAI could not confirm organisation administrator access.' : 'Organisation administrator access is required.')
    return null
  }
  const teamId = context.tenant.teamId ?? context.actionContext.teamId
  const team = await resolveUoaRosterTeam(deps.prisma, { organizationId: context.tenant.organizationId, teamId })
  if (!team || !teamId) {
    sendApiError(reply, 404, 'TEAM_NOT_LINKED', 'This team is not linked to UnlikeOtherAI.')
    return null
  }
  try {
    // This is a live exact-team capability check. It is not the local TeamMember
    // projection and UOA rechecks the signed actor assertion itself.
    const page = await listTeamMembers(team, { limit: 1 }, withUoaRosterSubjectAssertion(team, context.actionContext.uoaIdentity))
    if (!page.permissions.addMember) {
      sendApiError(reply, 403, 'TEAM_ADMIN_REQUIRED', 'Team administrator access is required.')
      return null
    }
  } catch {
    sendApiError(reply, 503, 'UOA_TEAM_ACCESS_UNAVAILABLE', 'UnlikeOtherAI could not confirm team administrator access.')
    return null
  }
  return { context, teamId }
}

/** One route family serves both shared Members tabs; it never reads email data. */
export const registerAutomaticMembershipRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const base = (scope: Scope) => `/api/${scope === 'organization' ? 'organization' : 'team'}/automatic-membership`
  for (const scope of ['organization', 'team'] as const) {
    if (scope === 'organization') {
      app.get(`${base(scope)}/teams`, async (request, reply) => {
        const access = await requireScopeAdministrator(deps, request, reply, scope)
        if (!access) return reply
        // Team names are a UOA mirror used only to let an authorised
        // administrator choose the exact UOA-backed team targets.
        const teams = await deps.prisma.team.findMany({
          where: { project: { organizationId: access.context.tenant.organizationId }, externalTeamId: { not: null } },
          select: { id: true, name: true }, orderBy: { name: 'asc' },
        })
        return createApiResponse({ teams })
      })
    }
    app.get(base(scope), async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      return createApiResponse(await listAutomaticMembershipRules(deps.prisma, access.context.tenant.organizationId, scope, access.teamId))
    })
    app.post(base(scope), async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      const body = parseInput(CreateAutomaticMembershipRuleSchema, request.body, reply)
      if (!body) return reply
      try {
        return createApiResponse(await createAutomaticMembershipRule(deps.prisma, access.context, scope, body, { authSecret: deps.authSecret ?? '', teamId: access.teamId }))
      } catch (error) { if (sendServiceError(reply, error)) return reply; throw error }
    })
    app.patch<{ Params: { ruleId: string } }>(`${base(scope)}/:ruleId`, async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      const body = parseInput(UpdateAutomaticMembershipRuleSchema, request.body, reply)
      if (!body) return reply
      try { return createApiResponse(await updateAutomaticMembershipRule(deps.prisma, access.context, request.params.ruleId, scope, body, access.teamId)) } catch (error) { if (sendServiceError(reply, error)) return reply; throw error }
    })
    app.post<{ Params: { ruleId: string } }>(`${base(scope)}/:ruleId/verify`, async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      try { return createApiResponse(await verifyAutomaticMembershipClaim(deps.prisma, access.context, request.params.ruleId, deps.authSecret ?? '')) } catch (error) { if (sendServiceError(reply, error)) return reply; throw error }
    })
    app.post<{ Params: { ruleId: string } }>(`${base(scope)}/:ruleId/rotate`, async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      try { return createApiResponse(await rotateAutomaticMembershipClaim(deps.prisma, access.context, request.params.ruleId, deps.authSecret ?? '')) } catch (error) { if (sendServiceError(reply, error)) return reply; throw error }
    })
    app.post<{ Params: { ruleId: string } }>(`${base(scope)}/:ruleId/activate`, async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      try { return createApiResponse(await activateAutomaticMembershipRule(deps.prisma, access.context, request.params.ruleId)) } catch (error) { if (sendServiceError(reply, error)) return reply; throw error }
    })
    app.post<{ Params: { ruleId: string } }>(`${base(scope)}/:ruleId/revoke`, async (request, reply) => {
      const access = await requireScopeAdministrator(deps, request, reply, scope)
      if (!access) return reply
      try { return createApiResponse(await revokeAutomaticMembershipRule(deps.prisma, access.context, request.params.ruleId)) } catch (error) { if (sendServiceError(reply, error)) return reply; throw error }
    })
  }
}
