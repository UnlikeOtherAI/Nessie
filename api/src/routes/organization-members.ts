import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { type AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createTeamInvitation,
  listMemberInvitationTargets,
  listOrganisationMemberInvitations,
  listOrganisationMembers,
  resolveLocalUserIdsByUoaSub,
  setTeamMemberActivation,
  updateOrganisationMemberRole,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaOrgRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterPage,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The organisation-wide roster: every member of the caller's UOA organisation,
 * with their ORG role — never scoped to a single team.
 *
 * This is deliberately a separate route from `/api/team/members`
 * (routes/team-members.ts), which is correctly TEAM-scoped and stays
 * that way. Before this file existed, the "Organization → Members" admin
 * page rendered the team-scoped roster, so it silently showed only whoever
 * was in the viewer's currently active team — never the whole organisation.
 * See docs/plans/2026-08-31-identity-belonging-audit.md for the audit this
 * bug belongs to (the org-vs-team scope confusion class, sibling of F10).
 *
 * Same UOA-owns-membership rules as the team roster: nothing is persisted
 * here, people are named by their UOA subject, and mutations require an
 * owner/admin actor plus a live subject assertion of the caller.
 */

const OrgRoleBodySchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
})

const RosterQuerySchema = z.object({
  cursor: z.string().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['ACTIVE', 'DEACTIVATED', 'REMOVED', 'all']).optional(),
})

const CreateMemberInvitationSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(200).optional(),
  teamId: z.string().trim().min(1).max(200),
  teamRole: z.string().trim().min(1).max(100).optional(),
})

const resolveOrganizationExternalId = async (
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
      'This organisation is not linked to an UnlikeOtherAI organisation',
    )
    return null
  }
  return organization.externalOrgId
}

/** Map a relay failure onto the API's error envelope. Returns true if handled. */
const sendRelayError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean => {
  if (error instanceof UoaInvitationAlreadyAcceptedError) {
    sendApiError(
      reply,
      409,
      'INVITATION_ALREADY_ACCEPTED',
      'This invitation was already accepted. Remove the member instead.',
    )
    return true
  }
  if (error instanceof UoaRosterRejectedError) {
    sendApiError(
      reply,
      error.statusCode === 404 ? 404 : 400,
      'ORGANIZATION_MEMBERS_REJECTED',
      'UnlikeOtherAI refused the request. The member may no longer exist.',
    )
    return true
  }
  if (error instanceof UoaRosterIdentityError) {
    sendApiError(
      reply,
      403,
      'UOA_SESSION_REQUIRED',
      'Sign in with UnlikeOtherAI to view organisation members.',
    )
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa organisation roster relay failed')
    sendApiError(
      reply,
      502,
      'UOA_DIRECTORY_UNAVAILABLE',
      'The UnlikeOtherAI directory is temporarily unavailable',
    )
    return true
  }
  return false
}

/**
 * `rosterDeps` is the injectable egress seam (pinned fetch + DNS), the same
 * one `services/uoa-org-roster.ts` takes. Production passes nothing.
 */
export const registerOrganizationMembersRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { requireActorContext } = deps

  const relay = async <TResult, TBody = undefined>(
    request: FastifyRequest,
    reply: FastifyReply,
    options: { parse?: () => TBody | null },
    run: (
      orgId: string,
      body: TBody,
      subjectDeps: UoaRosterDeps,
    ) => Promise<TResult>,
  ): Promise<FastifyReply | { data: TResult }> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = options.parse ? options.parse() : (undefined as TBody)
    if (body === null) return reply

    const orgId = await resolveOrganizationExternalId(deps, actorContext, reply)
    if (!orgId) return reply

    try {
      return createApiResponse(await run(
        orgId,
        body as TBody,
        withUoaOrgRosterSubjectAssertion(
          orgId,
          actorContext.actionContext.uoaIdentity,
          rosterDeps,
        ),
      ))
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }
  }

  const relayPage = async <TItem, TPermissions>(
    request: FastifyRequest,
    reply: FastifyReply,
    run: (
      orgId: string,
      actorContext: AuthorizedActionContext,
      subjectDeps: UoaRosterDeps,
    ) => Promise<UoaRosterPage<TItem, TPermissions>>,
  ): Promise<FastifyReply | { data: { items: TItem[]; permissions: TPermissions } }> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(RosterQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const orgId = await resolveOrganizationExternalId(deps, actorContext, reply)
    if (!orgId) return reply
    try {
      const result = await run(
        orgId,
        actorContext,
        withUoaOrgRosterSubjectAssertion(orgId, actorContext.actionContext.uoaIdentity, rosterDeps),
      )
      return createApiResponse({ items: result.items, permissions: result.permissions }, result.meta)
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }
  }

  /**
   * Every member of the organisation, with each person's local principal id
   * attached where one exists — same `resolveLocalUserIdsByUoaSub` join the
   * team roster uses, so this page can show a person beside the agents they
   * steward without Nessie storing a second copy of UOA's roster.
   */
  app.get('/api/organization/members', async (request, reply) =>
    relayPage(request, reply, async (orgId, actorContext, subjectDeps) => {
      const page = await listOrganisationMembers(
        orgId,
        RosterQuerySchema.parse(request.query),
        subjectDeps,
      )
      const localIdBySub = await resolveLocalUserIdsByUoaSub(
        deps.prisma,
        actorContext.tenant.organizationId,
        page.items.map((member) => member.uoaSub),
      )
      return {
        ...page,
        items: page.items.map((member) => {
          const userId = localIdBySub.get(member.uoaSub)
          return userId ? { ...member, userId } : member
        }),
      }
    }))

  app.get('/api/organization/member-invitation-targets', async (request, reply) =>
    relayPage(request, reply, async (orgId, _actorContext, subjectDeps) =>
      listMemberInvitationTargets(orgId, RosterQuerySchema.parse(request.query), subjectDeps)))

  app.get('/api/organization/member-invitations', async (request, reply) =>
    relayPage(request, reply, async (orgId, _actorContext, subjectDeps) =>
      listOrganisationMemberInvitations(orgId, RosterQuerySchema.parse(request.query), subjectDeps)))

  app.post('/api/organization/member-invitations', async (request, reply) =>
    relay(
      request,
      reply,
      { parse: () => parseInput(CreateMemberInvitationSchema, request.body, reply) },
      async (orgId, body, subjectDeps) => {
        const { teamId, ...invitation } = body
        await createTeamInvitation(
          { externalOrgId: orgId, externalTeamId: teamId },
          invitation,
          subjectDeps,
        )
        return { ok: true }
      },
    ))

  app.put<{ Params: { uoaSub: string } }>(
    '/api/organization/members/:uoaSub/role',
    async (request, reply) =>
      relay(
        request,
        reply,
        { parse: () => parseInput(OrgRoleBodySchema, request.body, reply) },
        async (orgId, body, subjectDeps) => {
          await updateOrganisationMemberRole(orgId, request.params.uoaSub, body.role, subjectDeps)
          return { ok: true }
        },
      ),
  )

  for (const action of ['deactivate', 'reactivate'] as const) {
    app.post<{ Params: { uoaSub: string } }>(
      `/api/organization/members/:uoaSub/${action}`,
      async (request, reply) =>
        relay(request, reply, {}, async (orgId, _body, subjectDeps) => {
          // Deactivation is already org-scoped upstream (posts to the org
          // path, not a team path) — reuse it unchanged.
          await setTeamMemberActivation(
            { externalOrgId: orgId },
            request.params.uoaSub,
            action,
            subjectDeps,
          )
          return { ok: true }
        }),
    )
  }
}
