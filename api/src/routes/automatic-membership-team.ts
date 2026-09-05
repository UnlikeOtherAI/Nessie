/**
 * The team surface for automatic team access.
 *
 * Deliberately narrow, and separate from the organisation routes because the
 * gate is different: these answer only to the owners/admins of the team in the
 * caller's session, as **UOA** decides it, and they never expose anything
 * organisation-wide.
 *
 * Two properties are the point, and both are enforced here rather than in the
 * client:
 *
 *  - The read returns only domains that already grant this team, so the team
 *    surface cannot be used to enumerate the organisation's domain inventory.
 *  - `includeChallenge` is false, so the DNS proof of domain control — an
 *    organisation-level secret — never reaches a team administrator.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  SetTeamAutomaticMembershipSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { isAutomaticMembershipEnabledForOrganization } from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  requireTeamAdministrator,
  resolveRuleAuthorization,
} from '../services/automatic-membership/access.js'
import { buildAutomaticMembershipResponse } from '../services/automatic-membership/read-model.js'
import { setTeamRule } from '../services/automatic-membership/rules.js'
import {
  actorUserId,
  auditRuleChange,
  guardFeature,
  IdParamSchema,
  sendDomainError,
} from './automatic-membership-support.js'
import type { RouteDeps } from './types.js'
import type { UoaRosterDeps } from '../services/uoa-org-roster.js'

export const registerTeamAutomaticMembershipRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { prisma } = deps

  const teamContext = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ actorContext: AuthorizedActionContext; teamId: string } | null> => {
    const actorContext = guardFeature(deps, request, reply)
    if (!actorContext) return null
    // The team comes from the session, never from the caller's body or query:
    // accepting one would let a team admin act on a team they do not administer.
    const teamId = actorContext.actionContext.teamId ?? actorContext.tenant.teamId
    if (!teamId) {
      sendApiError(reply, 404, 'TEAM_NOT_LINKED', 'No team is selected for this session.')
      return null
    }
    const team = await requireTeamAdministrator(deps, actorContext, teamId, reply, rosterDeps)
    if (!team) return null
    return { actorContext, teamId }
  }

  app.get('/api/team/automatic-membership', async (request, reply) => {
    const context = await teamContext(request, reply)
    if (!context) return reply
    const organizationId = context.actorContext.tenant.organizationId
    return createApiResponse(
      await buildAutomaticMembershipResponse(prisma, {
        includeChallenge: false,
        manageableTeamIds: new Set([context.teamId]),
        organizationId,
        permissions: {
          manageDomains: false,
          manageReconciliation: false,
          manageRules: true,
        },
        provisioningEnabled: await isAutomaticMembershipEnabledForOrganization(
          prisma,
          organizationId,
        ),
        scope: { kind: 'team', teamId: context.teamId },
      }),
    )
  })

  app.put('/api/team/automatic-membership/domains/:id', async (request, reply) => {
    const context = await teamContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(SetTeamAutomaticMembershipSchema, request.body, reply)
    if (!body) return reply
    const authorization = resolveRuleAuthorization(context.actorContext, reply)
    if (!authorization) return reply
    try {
      const change = await setTeamRule(prisma, {
        authorization,
        createdByUserId: actorUserId(context.actorContext),
        domainId: params.id,
        enabled: body.enabled,
        organizationId: context.actorContext.tenant.organizationId,
        teamId: context.teamId,
      })
      await auditRuleChange(deps, context.actorContext, params.id, change)
      return createApiResponse({ enabled: body.enabled })
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })
}
