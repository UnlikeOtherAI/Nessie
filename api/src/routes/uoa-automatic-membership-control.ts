import { createHash } from 'node:crypto'

import type { AuthorizedActionContext } from '@nessie/schemas'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { sendApiError } from '../lib/api.js'
import {
  activateAutomaticMembershipRule,
  AutomaticMembershipError,
  createAutomaticMembershipRule,
  listAutomaticMembershipRules,
  listAutomaticMembershipTargetTeams,
  releaseAutomaticMembershipClaim,
  revokeAutomaticMembershipRule,
  rotateAutomaticMembershipClaim,
  suspendAutomaticMembershipRule,
  updateAutomaticMembershipRule,
  verifyAutomaticMembershipClaim,
} from '../services/automatic-membership.js'
import type { RouteDeps } from './types.js'
import {
  reserveUoaAutomaticMembershipControlRequest,
  verifyUoaAutomaticMembershipControlSignature,
} from '../services/uoa-automatic-membership-control-auth.js'
import {
  hasExactUoaTeamBindings,
  isUoaControlActionAllowed,
  isUoaControlRuleAction,
  UoaControlActionSchema,
  UoaControlPayloadSchemas,
  type UoaControlScope,
} from '../services/uoa-automatic-membership-control-contract.js'

const CONTROL_PATH = '/api/internal/uoa/automatic-membership/control'
const REPLAY_TTL_MS = 5 * 60_000
const ExternalIdSchema = z.string().trim().min(1).max(200)
const ScopeSchema = z.enum(['organisation', 'team'])
const RequestSchema = z.object({
  request_id: z.string().uuid(),
  uoa_actor_sub: ExternalIdSchema,
  external_org_id: ExternalIdSchema,
  external_team_id: ExternalIdSchema.optional(),
  scope: ScopeSchema,
  action: UoaControlActionSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict()

const bodyText = (body: unknown): string => JSON.stringify(body)
const firstHeader = (request: FastifyRequest, name: string): string | null => {
  const value = request.headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.length > 0 ? first : null
}

const controlContext = (input: {
  organizationId: string
  teamId?: string
  actorSub: string
  requestId: string
}): AuthorizedActionContext => ({
  actor: { actorType: 'service', actorId: `uoa:${input.actorSub}` },
  tenant: { organizationId: input.organizationId, ...(input.teamId ? { teamId: input.teamId } : {}) },
  actionContext: {
    requestId: input.requestId,
    ...(input.teamId ? { teamId: input.teamId } : {}),
    uoaControlSubject: input.actorSub,
  },
})

const membershipScope = (scope: UoaControlScope): 'organization' | 'team' =>
  scope === 'organisation' ? 'organization' : 'team'

const sendControlError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof AutomaticMembershipError) return sendApiError(reply, error.statusCode, error.code, error.message)
  return sendApiError(reply, 500, 'UOA_CONTROL_FAILED', 'Automatic membership control could not be completed.')
}

const mapTargetTeams = async (
  deps: RouteDeps,
  organizationId: string,
  externalOrgId: string,
  externalIds: readonly string[],
): Promise<string[]> => {
  const unique = [...new Set(externalIds)]
  const teams = await deps.prisma.team.findMany({
    where: { externalOrgId, externalTeamId: { in: unique } }, select: { id: true, externalTeamId: true },
  })
  if (!hasExactUoaTeamBindings(externalIds, teams.map((team) => team.externalTeamId))) {
    throw new AutomaticMembershipError(
      'INVALID_TEAM_TARGET', 'One or more UOA teams are not bound to this organisation.', 403,
    )
  }
  // The org predicate is intentionally repeated here rather than inferred through Team.projectId.
  const organization = await deps.prisma.organization.findFirst({
    where: { id: organizationId, externalOrgId }, select: { id: true },
  })
  if (!organization) {
    throw new AutomaticMembershipError('ORGANIZATION_NOT_LINKED', 'The UOA organisation is not bound to Nessie.', 404)
  }
  return teams.map((team) => team.id)
}

const requireRuleScope = async (
  deps: RouteDeps,
  ruleId: string,
  organizationId: string,
  scope: 'organization' | 'team',
  teamId?: string,
): Promise<void> => {
  const rule = await deps.prisma.automaticMembershipRule.findFirst({
    where: {
      id: ruleId, organizationId, scope,
      ...(scope === 'team' ? { targets: { some: { teamId } } } : {}),
    },
    select: { id: true },
  })
  if (!rule) {
    throw new AutomaticMembershipError(
      'RULE_NOT_FOUND', 'Automatic membership rule was not found in this UOA scope.', 404,
    )
  }
}

const aggregate = async (
  deps: RouteDeps,
  input: { organizationId: string; scope: 'organization' | 'team'; teamId?: string; authSecret: string },
) => listAutomaticMembershipRules(
  deps.prisma, input.organizationId, input.scope, input.teamId, input.authSecret,
)

type MembershipAggregate = Awaited<ReturnType<typeof aggregate>>

const wireScope = (scope: 'organization' | 'team'): UoaControlScope =>
  scope === 'organization' ? 'organisation' : 'team'

const wireState = (rule: MembershipAggregate['rules'][number]):
  'pending' | 'verified' | 'active' | 'suspended' | 'revoked' | 'rotating' => {
  if (rule.state === 'revoked') return 'revoked'
  if (rule.claimState === 'challenge_rotation') return 'rotating'
  if (rule.state === 'active') return 'active'
  if (rule.state === 'suspended' || rule.claimState === 'suspended') return 'suspended'
  return rule.claimState === 'verified' ? 'verified' : 'pending'
}

const toUoaControlResponse = async (
  deps: RouteDeps,
  aggregateResponse: MembershipAggregate,
  input: { organizationId: string; externalOrgId: string; scope: 'organization' | 'team' },
) => {
  const ruleIds = aggregateResponse.rules.map((rule) => rule.id)
  const targetIds = aggregateResponse.rules.flatMap((rule) => rule.targetTeamIds)
  const claimIds = aggregateResponse.rules.map((rule) => rule.claimId)
  const [teams, claims, runs, audit] = await Promise.all([
    deps.prisma.team.findMany({
      where: { id: { in: targetIds }, externalOrgId: input.externalOrgId, externalTeamId: { not: null } },
      select: { id: true, externalTeamId: true },
    }),
    deps.prisma.automaticMembershipDomainClaim.findMany({
      where: { id: { in: claimIds }, organizationId: input.organizationId },
      select: { id: true, lastDnsFailure: true },
    }),
    deps.prisma.automaticMembershipBackfillRun.findMany({
      where: { ruleId: { in: ruleIds }, organizationId: input.organizationId },
      orderBy: { updatedAt: 'desc' }, select: { ruleId: true, lastError: true },
    }),
    deps.prisma.auditLog.findMany({
      where: {
        organizationId: input.organizationId,
        resourceType: 'automatic_membership_rule',
        resourceId: { in: ruleIds },
      },
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, action: true, createdAt: true, reason: true },
    }),
  ])
  const externalTeamId = new Map(teams.flatMap((team) =>
    team.externalTeamId ? [[team.id, team.externalTeamId] as const] : []
  ))
  const claimFailure = new Map(claims.map((claim) => [claim.id, claim.lastDnsFailure]))
  const latestRun = new Map<string, (typeof runs)[number]>()
  for (const run of runs) if (!latestRun.has(run.ruleId)) latestRun.set(run.ruleId, run)
  return {
    rules: aggregateResponse.rules.map((rule) => {
      const run = latestRun.get(rule.id)
      const teamIds = rule.targetTeamIds.flatMap((teamId) =>
        externalTeamId.has(teamId) ? [externalTeamId.get(teamId)!] : []
      )
      if (teamIds.length !== rule.targetTeamIds.length) {
        throw new AutomaticMembershipError(
          'RULE_TARGET_UNBOUND', 'A rule target is no longer bound to its UOA team.', 409,
        )
      }
      return {
        id: rule.id,
        domain: rule.domain,
        scope: wireScope(rule.scope),
        external_team_id: rule.scope === 'team' ? teamIds[0] ?? null : null,
        state: wireState(rule),
        notification_email: rule.notificationEmail,
        team_ids: teamIds,
        dns: rule.dns ? { record_name: rule.dns.name, record_value: rule.dns.value } : null,
        last_check_at: rule.lastDnsCheckAt,
        last_check_error: boundedDetail(claimFailure.get(rule.claimId) ?? null, 500),
        verification_expires_at: rule.verificationExpiresAt,
        backfill: rule.backfill ? {
          status: rule.backfill.status,
          processed: rule.backfill.processedCount,
          granted: rule.backfill.grantedCount,
          failed: rule.backfill.failedCount,
          error: boundedDetail(run?.lastError ?? null, 500),
        } : null,
      }
    }),
    audit: audit.map((entry) => ({
      id: entry.id,
      action: entry.action,
      created_at: entry.createdAt.toISOString(),
      detail: boundedDetail(entry.reason, 1000),
    })),
  }
}

const boundedDetail = (value: string | null, maximum: number): string | null =>
  value === null ? null : value.slice(0, maximum)

const toUoaTargetTeams = async (deps: RouteDeps, externalOrgId: string) => {
  const teams = await listAutomaticMembershipTargetTeams(deps.prisma, externalOrgId)
  const bound = await deps.prisma.team.findMany({
    where: { id: { in: teams.map((team) => team.id) }, externalOrgId, externalTeamId: { not: null } },
    select: { id: true, externalTeamId: true },
  })
  const externalIds = new Map(bound.flatMap((team) =>
    team.externalTeamId ? [[team.id, team.externalTeamId] as const] : []
  ))
  return teams.flatMap((team) => externalIds.has(team.id)
    ? [{ external_team_id: externalIds.get(team.id)!, name: team.name }]
    : [])
}

/** UOA's admin UI uses this signed bridge; no Nessie session or local member record is accepted. */
export const registerUoaAutomaticMembershipControlRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  app.post(CONTROL_PATH, async (request, reply) => {
    const secret = process.env.NESSIE_UOA_AUTOMATIC_MEMBERSHIP_CONTROL_SECRET?.trim()
    const timestamp = firstHeader(request, 'x-uoa-automatic-membership-timestamp')
    const signature = firstHeader(request, 'x-uoa-automatic-membership-signature')
    const requestId = firstHeader(request, 'x-uoa-automatic-membership-request-id')
    if (!verifyUoaAutomaticMembershipControlSignature(secret, timestamp, signature, request.body)) {
      return sendApiError(reply, 401, 'UOA_CONTROL_UNAUTHORIZED', 'The UOA control request could not be authenticated.')
    }
    const body = RequestSchema.safeParse(request.body)
    if (!body.success) {
      return sendApiError(reply, 400, 'INVALID_UOA_CONTROL_REQUEST', 'The UOA control request is invalid.')
    }
    if (requestId !== body.data.request_id) {
      return sendApiError(reply, 401, 'UOA_CONTROL_UNAUTHORIZED', 'The UOA control request could not be authenticated.')
    }
    if (!deps.authSecret) {
      return sendApiError(
        reply, 503, 'AUTOMATIC_MEMBERSHIP_NOT_CONFIGURED',
        'Automatic membership is not configured on this deployment.',
      )
    }

    const organization = await deps.prisma.organization.findUnique({
      where: { externalOrgId: body.data.external_org_id },
      select: { id: true, externalOrgId: true },
    })
    if (!organization?.externalOrgId) {
      return sendApiError(reply, 404, 'ORGANIZATION_NOT_LINKED', 'The UOA organisation is not bound to Nessie.')
    }
    let teamId: string | undefined
    if (body.data.scope === 'team') {
      if (!body.data.external_team_id) {
        return sendApiError(reply, 400, 'UOA_TEAM_REQUIRED', 'A UOA team is required for team-scoped control.')
      }
      const team = await deps.prisma.team.findFirst({
        where: { externalOrgId: body.data.external_org_id, externalTeamId: body.data.external_team_id },
        select: { id: true },
      })
      if (!team) return sendApiError(reply, 404, 'TEAM_NOT_LINKED', 'The UOA team is not bound to this organisation.')
      teamId = team.id
    } else if (body.data.external_team_id) {
      return sendApiError(reply, 400, 'UNEXPECTED_UOA_TEAM', 'Organisation-scoped control cannot include a UOA team.')
    }

    const digest = createHash('sha256').update(bodyText(request.body)).digest('hex')
    const reserved = await reserveUoaAutomaticMembershipControlRequest(
      deps.prisma.uoaAutomaticMembershipControlRequest,
      {
        requestId: body.data.request_id,
        requestDigest: digest,
        organizationId: organization.id,
        uoaActorSub: body.data.uoa_actor_sub,
        action: body.data.action,
        ttlMs: REPLAY_TTL_MS,
      },
    )
    if (!reserved) {
      return sendApiError(reply, 409, 'UOA_CONTROL_REPLAY', 'This UOA control request has already been processed.')
    }

    try {
      if (!isUoaControlActionAllowed(body.data.action, body.data.scope)) {
        throw new AutomaticMembershipError(
          'INVALID_UOA_CONTROL_ACTION', 'Only organisations can list target teams.', 400,
        )
      }
      const context = controlContext({
        organizationId: organization.id,
        teamId,
        actorSub: body.data.uoa_actor_sub,
        requestId: body.data.request_id,
      })
      const scope = membershipScope(body.data.scope)
      if (body.data.action === 'list') UoaControlPayloadSchemas.list.parse(body.data.payload)
      if (body.data.action === 'teams') {
        UoaControlPayloadSchemas.teams.parse(body.data.payload)
        return { teams: await toUoaTargetTeams(deps, organization.externalOrgId) }
      }
      if (body.data.action === 'create') {
        const payload = UoaControlPayloadSchemas.create.parse(body.data.payload)
        if (body.data.scope === 'team' && payload.team_ids !== undefined) {
          throw new AutomaticMembershipError(
            'TEAM_MAPPING_NOT_ALLOWED', 'Team rules always target their own UOA team.', 400,
          )
        }
        const targets = body.data.scope === 'team'
          ? [teamId!]
          : await mapTargetTeams(
            deps, organization.id, organization.externalOrgId, payload.team_ids ?? [],
          )
        await createAutomaticMembershipRule(
          deps.prisma, context, scope,
          {
            domain: payload.domain,
            notificationEmail: payload.notification_email ?? undefined,
            targetTeamIds: targets,
          },
          { authSecret: deps.authSecret, teamId, externalOrgId: organization.externalOrgId },
        )
      }
      if (body.data.action === 'update') {
        const payload = UoaControlPayloadSchemas.update.parse(body.data.payload)
        if (body.data.scope === 'team' && payload.team_ids !== undefined) {
          throw new AutomaticMembershipError(
            'TEAM_MAPPING_NOT_ALLOWED', 'Team rules always target their own UOA team.', 400,
          )
        }
        await requireRuleScope(deps, payload.rule_id, organization.id, scope, teamId)
        const targets = payload.team_ids === undefined
          ? undefined
          : await mapTargetTeams(deps, organization.id, organization.externalOrgId, payload.team_ids)
        await updateAutomaticMembershipRule(
          deps.prisma, context, payload.rule_id, scope,
          { notificationEmail: payload.notification_email, targetTeamIds: targets }, teamId,
        )
      }
      if (isUoaControlRuleAction(body.data.action)) {
        const payload = UoaControlPayloadSchemas[body.data.action].parse(body.data.payload)
        await requireRuleScope(deps, payload.rule_id, organization.id, scope, teamId)
        if (body.data.action === 'verify') {
          await verifyAutomaticMembershipClaim(deps.prisma, context, payload.rule_id, deps.authSecret)
        }
        if (body.data.action === 'rotate') {
          await rotateAutomaticMembershipClaim(deps.prisma, context, payload.rule_id, deps.authSecret)
        }
        if (body.data.action === 'activate') {
          await activateAutomaticMembershipRule(deps.prisma, context, payload.rule_id)
        }
        if (body.data.action === 'suspend') {
          await suspendAutomaticMembershipRule(deps.prisma, context, payload.rule_id)
        }
        if (body.data.action === 'revoke') {
          await revokeAutomaticMembershipRule(deps.prisma, context, payload.rule_id)
        }
      }
      if (body.data.action === 'release') {
        const payload = UoaControlPayloadSchemas.release.parse(body.data.payload)
        await requireRuleScope(deps, payload.rule_id, organization.id, scope, teamId)
        const rule = await deps.prisma.automaticMembershipRule.findFirst({
          where: { id: payload.rule_id, organizationId: organization.id, scope }, select: { claimId: true },
        })
        if (!rule) throw new AutomaticMembershipError('RULE_NOT_FOUND', 'Automatic membership rule was not found.', 404)
        await releaseAutomaticMembershipClaim(deps.prisma, context, rule.claimId)
      }
      return toUoaControlResponse(
        deps,
        await aggregate(deps, { organizationId: organization.id, scope, teamId, authSecret: deps.authSecret }),
        { organizationId: organization.id, externalOrgId: organization.externalOrgId, scope },
      )
    } catch (error) {
      if (error instanceof z.ZodError) {
        return sendApiError(reply, 400, 'INVALID_UOA_CONTROL_PAYLOAD', 'The action payload is invalid.')
      }
      return sendControlError(reply, error)
    }
  })
}
