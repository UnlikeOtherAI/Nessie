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
 *  - The read returns only PROVEN domains, so an organisation-level claim still
 *    in progress is not visible here — and it lists them all rather than only
 *    the ones already granting this team, or attaching a team would have no
 *    doorway at all.
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
import { reauthorizeRule, setTeamRule } from '../services/automatic-membership/rules.js'
import { emitAuditEvent } from '../services/audit.js'
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

  /**
   * A team administrator repairs their own team's rule.
   *
   * The organisation route exists too, but it is organisation-admin gated, so
   * without this the Re-authorize button the team surface renders could only
   * ever 403. The rule is pinned to the caller's own team before anything is
   * re-stamped, and what is stamped is the caller's own live identity — nobody
   * can be made to authorize something they did not click.
   */
  app.post('/api/team/automatic-membership/rules/:id/reauthorize', async (request, reply) => {
    const context = await teamContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    const authorization = resolveRuleAuthorization(context.actorContext, reply)
    if (!authorization) return reply
    const owned = await prisma.automaticMembershipRule.findFirst({
      select: { id: true },
      where: {
        domain: { organizationId: context.actorContext.tenant.organizationId },
        id: params.id,
        teamId: context.teamId,
      },
    })
    if (!owned) {
      sendApiError(
        reply,
        404,
        'AUTOMATIC_MEMBERSHIP_NOT_FOUND',
        'No such rule for this team.',
      )
      return reply
    }
    try {
      const rule = await reauthorizeRule(prisma, {
        authorization,
        organizationId: context.actorContext.tenant.organizationId,
        ruleId: params.id,
      })
      await emitAuditEvent(prisma, {
        action: 'organization.automatic_membership.rule_reauthorized',
        actorContext: context.actorContext,
        metadata: { scope: 'team', teamId: rule.teamId },
        outcome: 'success',
        resourceId: params.id,
        resourceType: 'automatic_membership_rule',
      })
      return createApiResponse({ ok: true })
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
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
