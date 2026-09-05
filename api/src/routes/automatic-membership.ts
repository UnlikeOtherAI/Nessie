/**
 * Automatic team access after sign-in, by DNS-verified email domain.
 * Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md §12.
 *
 * Two surfaces, one response shape, two gates:
 *
 *  - `/api/organization/automatic-membership` — organisation owner/admin.
 *    Claims, proves, rotates, suspends and releases domains; sets the team list;
 *    runs reconciliation; holds the emergency stop.
 *  - `/api/team/automatic-membership` — the owners/admins of one team, decided
 *    by UOA. It reads only domains that already grant that team, and toggles
 *    only that team.
 *
 * No route in this file accepts a role. An automatic grant is always an
 * ordinary member, so there is nothing for a caller to escalate.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  AUTOMATIC_MEMBERSHIP_SETTING_KEY,
  CreateAutomaticMembershipDomainSchema,
  DOMAIN_REJECTION_MESSAGES,
  SetAutomaticMembershipDomainStatusSchema,
  SetAutomaticMembershipEnabledSchema,
  SetAutomaticMembershipTeamsSchema,
  SetTeamAutomaticMembershipSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  defaultDomainVerificationDns,
  isAutomaticMembershipEnabledForOrganization,
  type DomainVerificationDns,
} from '@nessie/team-admin'
import { writeScopedSetting } from '@nessie/runtime'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  requireOrganizationAdministrator,
  requireTeamAdministrator,
  resolveExternalOrgId,
  resolveRuleAuthorization,
} from '../services/automatic-membership/access.js'
import {
  AutomaticMembershipDomainError,
  claimDomain,
  revokeDomain,
  rotateChallenge,
  setDomainStatus,
  verifyDomain,
} from '../services/automatic-membership/domains.js'
import {
  buildAutomaticMembershipResponse,
} from '../services/automatic-membership/read-model.js'
import {
  reauthorizeRule,
  setDomainTeams,
  setTeamRule,
  type RuleChange,
} from '../services/automatic-membership/rules.js'
import {
  cancelReconciliation,
  startReconciliation,
  supersedeReconciliations,
} from '../services/automatic-membership/reconciliation.js'
import type { RouteDeps } from './types.js'
import type { UoaRosterDeps } from '../services/uoa-org-roster.js'

const IdParamSchema = z.object({ id: z.string().uuid() })

const sendDomainError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof AutomaticMembershipDomainError)) return false
  sendApiError(
    reply,
    error.statusCode,
    error.code,
    error.rejection ? DOMAIN_REJECTION_MESSAGES[error.rejection] : error.message,
    undefined,
    error.rejection ? { reason: error.rejection } : undefined,
  )
  return true
}

const actorUserId = (actorContext: AuthorizedActionContext): string | null =>
  actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null

export const registerAutomaticMembershipRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  /**
   * Injectable egress seams, the same convention `team-members.ts` uses:
   * `rosterDeps` is the pinned-fetch UOA transport, `dns` is the TXT resolver.
   * Production passes neither.
   */
  rosterDeps: UoaRosterDeps = {},
  dns: DomainVerificationDns = defaultDomainVerificationDns,
): void => {
  const { prisma, requireActorContext } = deps

  /**
   * The instance rollout gate, and the one that is fail-closed: with the flag
   * off every route 404s and the admin never renders the tab. The
   * per-organisation emergency stop is a separate, softer switch (§11).
   */
  const featureEnabled = (): boolean => deps.config.automaticMembership.enabled === true

  const guard = (request: FastifyRequest, reply: FastifyReply): AuthorizedActionContext | null => {
    if (!featureEnabled()) {
      sendApiError(
        reply,
        404,
        'AUTOMATIC_MEMBERSHIP_DISABLED',
        'Automatic team access is not enabled on this instance.',
      )
      return null
    }
    return requireActorContext(request, reply)
  }

  /** Organisation-admin preamble shared by every organisation route. */
  const orgContext = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ actorContext: AuthorizedActionContext; externalOrgId: string } | null> => {
    const actorContext = guard(request, reply)
    if (!actorContext) return null
    const externalOrgId = await resolveExternalOrgId(deps, actorContext, reply)
    if (!externalOrgId) return null
    const allowed = await requireOrganizationAdministrator(
      actorContext,
      externalOrgId,
      reply,
      rosterDeps,
    )
    if (!allowed) return null
    return { actorContext, externalOrgId }
  }

  const auditRuleChange = async (
    actorContext: AuthorizedActionContext,
    domainId: string,
    change: RuleChange,
  ): Promise<void> => {
    if (change.added.length === 0 && change.removed.length === 0) return
    await emitAuditEvent(prisma, {
      action: 'organization.automatic_membership.rule_changed',
      actorContext,
      metadata: {
        addedTeamIds: change.added.map((rule) => rule.teamId),
        removedTeamIds: change.removed.map((rule) => rule.teamId),
      },
      outcome: 'success',
      resourceId: domainId,
      resourceType: 'automatic_membership_domain',
    })
  }

  app.get('/api/organization/automatic-membership', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const organizationId = context.actorContext.tenant.organizationId
    return createApiResponse(
      await buildAutomaticMembershipResponse(prisma, {
        includeChallenge: true,
        manageableTeamIds: 'all',
        organizationId,
        permissions: {
          manageDomains: true,
          manageReconciliation: true,
          manageRules: true,
        },
        provisioningEnabled: await isAutomaticMembershipEnabledForOrganization(
          prisma,
          organizationId,
        ),
        scope: { kind: 'organization' },
      }),
    )
  })

  app.put('/api/organization/automatic-membership/enabled', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const body = parseInput(SetAutomaticMembershipEnabledSchema, request.body, reply)
    if (!body) return reply
    const updatedByUserId = actorUserId(context.actorContext)
    if (!updatedByUserId) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Only a signed-in person can change this.')
      return reply
    }
    await writeScopedSetting(prisma, {
      key: AUTOMATIC_MEMBERSHIP_SETTING_KEY,
      // Organisation scope with no team or user id, so the lower tiers of the
      // cascade cannot re-enable what an organisation turned off.
      locked: false,
      organizationId: context.actorContext.tenant.organizationId,
      scope: 'organization',
      updatedByUserId,
      value: body.enabled,
    })
    await emitAuditEvent(prisma, {
      action: 'organization.automatic_membership.provisioning_toggled',
      actorContext: context.actorContext,
      metadata: { enabled: body.enabled },
      outcome: 'success',
      resourceId: context.actorContext.tenant.organizationId,
      resourceType: 'organization',
    })
    return createApiResponse({ enabled: body.enabled })
  })

  app.post('/api/organization/automatic-membership/domains', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const body = parseInput(CreateAutomaticMembershipDomainSchema, request.body, reply)
    if (!body) return reply
    try {
      const created = await claimDomain(prisma, {
        createdByUserId: actorUserId(context.actorContext),
        domain: body.domain,
        organizationId: context.actorContext.tenant.organizationId,
      })
      await emitAuditEvent(prisma, {
        action: 'organization.automatic_membership.domain_created',
        actorContext: context.actorContext,
        // The challenge is deliberately absent: it is the proof of control.
        metadata: { domain: created.domain },
        outcome: 'success',
        resourceId: created.id,
        resourceType: 'automatic_membership_domain',
      })
      return reply.code(201).send(createApiResponse({ domain: created.domain, id: created.id }))
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/organization/automatic-membership/domains/:id/verify', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      const outcome = await verifyDomain(
        prisma,
        params.id,
        context.actorContext.tenant.organizationId,
        dns,
      )
      await emitAuditEvent(prisma, {
        action: 'organization.automatic_membership.dns_checked',
        actorContext: context.actorContext,
        metadata: { outcome: outcome.kind },
        outcome: outcome.kind === 'failed' || outcome.kind === 'expired' ? 'denied' : 'success',
        resourceId: params.id,
        resourceType: 'automatic_membership_domain',
      })
      if (outcome.kind === 'verified') {
        await emitAuditEvent(prisma, {
          action: 'organization.automatic_membership.domain_verified',
          actorContext: context.actorContext,
          outcome: 'success',
          resourceId: params.id,
          resourceType: 'automatic_membership_domain',
        })
      }
      return createApiResponse(outcome)
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })

  app.post(
    '/api/organization/automatic-membership/domains/:id/rotate-challenge',
    async (request, reply) => {
      const context = await orgContext(request, reply)
      if (!context) return reply
      const params = parseInput(IdParamSchema, request.params, reply, 'params')
      if (!params) return reply
      try {
        const challenge = await rotateChallenge(
          prisma,
          params.id,
          context.actorContext.tenant.organizationId,
        )
        await emitAuditEvent(prisma, {
          action: 'organization.automatic_membership.challenge_rotated',
          actorContext: context.actorContext,
          outcome: 'success',
          resourceId: params.id,
          resourceType: 'automatic_membership_domain',
        })
        return createApiResponse({ challenge })
      } catch (error) {
        if (sendDomainError(reply, error)) return reply
        throw error
      }
    },
  )

  app.patch('/api/organization/automatic-membership/domains/:id', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(SetAutomaticMembershipDomainStatusSchema, request.body, reply)
    if (!body) return reply
    try {
      await setDomainStatus(
        prisma,
        params.id,
        context.actorContext.tenant.organizationId,
        body.status,
      )
      await emitAuditEvent(prisma, {
        action: body.status === 'active'
          ? 'organization.automatic_membership.domain_activated'
          : 'organization.automatic_membership.domain_suspended',
        actorContext: context.actorContext,
        outcome: 'success',
        resourceId: params.id,
        resourceType: 'automatic_membership_domain',
      })
      return createApiResponse({ status: body.status })
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/organization/automatic-membership/domains/:id', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      await revokeDomain(prisma, params.id, context.actorContext.tenant.organizationId)
      await supersedeReconciliations(prisma, params.id)
      await emitAuditEvent(prisma, {
        action: 'organization.automatic_membership.domain_revoked',
        actorContext: context.actorContext,
        outcome: 'success',
        resourceId: params.id,
        resourceType: 'automatic_membership_domain',
      })
      return createApiResponse({ ok: true })
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })

  app.put('/api/organization/automatic-membership/domains/:id/teams', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    const body = parseInput(SetAutomaticMembershipTeamsSchema, request.body, reply)
    if (!body) return reply
    const authorization = resolveRuleAuthorization(context.actorContext, reply)
    if (!authorization) return reply
    try {
      const change = await setDomainTeams(prisma, {
        authorization,
        createdByUserId: actorUserId(context.actorContext),
        domainId: params.id,
        organizationId: context.actorContext.tenant.organizationId,
        teamIds: body.teamIds,
      })
      // A run started against the previous team set must not keep granting for
      // a team that has just been removed.
      if (change.added.length > 0 || change.removed.length > 0) {
        await supersedeReconciliations(prisma, params.id)
      }
      await auditRuleChange(context.actorContext, params.id, change)
      return createApiResponse({ added: change.added.length, removed: change.removed.length })
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/organization/automatic-membership/rules/:id/reauthorize', async (request, reply) => {
    const context = await orgContext(request, reply)
    if (!context) return reply
    const params = parseInput(IdParamSchema, request.params, reply, 'params')
    if (!params) return reply
    const authorization = resolveRuleAuthorization(context.actorContext, reply)
    if (!authorization) return reply
    try {
      const rule = await reauthorizeRule(prisma, {
        authorization,
        organizationId: context.actorContext.tenant.organizationId,
        ruleId: params.id,
      })
      await emitAuditEvent(prisma, {
        action: 'organization.automatic_membership.rule_reauthorized',
        actorContext: context.actorContext,
        metadata: { teamId: rule.teamId },
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

  app.post(
    '/api/organization/automatic-membership/domains/:id/reconciliations',
    async (request, reply) => {
      const context = await orgContext(request, reply)
      if (!context) return reply
      const params = parseInput(IdParamSchema, request.params, reply, 'params')
      if (!params) return reply
      const authorization = resolveRuleAuthorization(context.actorContext, reply)
      if (!authorization) return reply
      try {
        const run = await startReconciliation(prisma, {
          authorization,
          domainId: params.id,
          organizationId: context.actorContext.tenant.organizationId,
          requestedByUserId: actorUserId(context.actorContext),
        })
        if (!run) return createApiResponse({ started: false })
        await emitAuditEvent(prisma, {
          action: 'organization.automatic_membership.reconcile_started',
          actorContext: context.actorContext,
          metadata: { ruleCount: run.ruleIds.length },
          outcome: 'success',
          resourceId: run.id,
          resourceType: 'automatic_membership_reconciliation',
        })
        return reply.code(202).send(createApiResponse({ id: run.id, started: true }))
      } catch (error) {
        if (sendDomainError(reply, error)) return reply
        throw error
      }
    },
  )

  app.delete(
    '/api/organization/automatic-membership/reconciliations/:id',
    async (request, reply) => {
      const context = await orgContext(request, reply)
      if (!context) return reply
      const params = parseInput(IdParamSchema, request.params, reply, 'params')
      if (!params) return reply
      try {
        await cancelReconciliation(prisma, {
          organizationId: context.actorContext.tenant.organizationId,
          reconciliationId: params.id,
        })
        await emitAuditEvent(prisma, {
          action: 'organization.automatic_membership.reconcile_cancelled',
          actorContext: context.actorContext,
          outcome: 'success',
          resourceId: params.id,
          resourceType: 'automatic_membership_reconciliation',
        })
        return createApiResponse({ ok: true })
      } catch (error) {
        if (sendDomainError(reply, error)) return reply
        throw error
      }
    },
  )

  /**
   * The team surface. Owner/admin of THIS team only, decided by UOA, and it
   * never returns the challenge — a domain claim is an organisation-level act,
   * so its proof of control is not a team admin's to read.
   */
  const teamContext = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ actorContext: AuthorizedActionContext; teamId: string } | null> => {
    const actorContext = guard(request, reply)
    if (!actorContext) return null
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
      await auditRuleChange(context.actorContext, params.id, change)
      return createApiResponse({ enabled: body.enabled })
    } catch (error) {
      if (sendDomainError(reply, error)) return reply
      throw error
    }
  })
}
