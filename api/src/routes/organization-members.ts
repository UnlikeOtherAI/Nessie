import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  listOrganisationMembers,
  resolveLocalUserIdsByUoaSub,
  setWorkspaceMemberActivation,
  updateOrganisationMemberRole,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaOrgRosterSubjectAssertion,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The organisation-wide roster: every member of the caller's UOA organisation,
 * with their ORG role — never scoped to a single team.
 *
 * This is deliberately a separate route from `/api/workspace/members`
 * (routes/workspace-members.ts), which is correctly TEAM-scoped and stays
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

const requireOrganizationAdmin = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): boolean => {
  const allowed = actorContext.actor.actorType === 'user' && isAdminActor(actorContext)
  if (!allowed) {
    sendApiError(
      reply,
      403,
      'FORBIDDEN',
      'Only organisation owners and admins can change organisation membership',
    )
  }
  return allowed
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
    options: { admin: boolean; parse?: () => TBody | null },
    run: (
      orgId: string,
      body: TBody,
      subjectDeps: UoaRosterDeps,
    ) => Promise<TResult>,
  ): Promise<FastifyReply | { data: TResult }> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (options.admin && !requireOrganizationAdmin(actorContext, reply)) return reply

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

  /**
   * Every member of the organisation, with each person's local principal id
   * attached where one exists — same `resolveLocalUserIdsByUoaSub` join the
   * team roster uses, so this page can show a person beside the agents they
   * steward without Nessie storing a second copy of UOA's roster.
   */
  app.get('/api/organization/members', async (request, reply) =>
    relay(request, reply, { admin: false }, async (orgId, _body, subjectDeps) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) throw new Error('unreachable: actor context already required')
      const members = await listOrganisationMembers(orgId, subjectDeps)
      const localIdBySub = await resolveLocalUserIdsByUoaSub(
        deps.prisma,
        actorContext.tenant.organizationId,
        members.map((member) => member.uoaSub),
      )
      return {
        members: members.map((member) => {
          const userId = localIdBySub.get(member.uoaSub)
          return userId ? { ...member, userId } : member
        }),
      }
    }))

  app.put<{ Params: { uoaSub: string } }>(
    '/api/organization/members/:uoaSub/role',
    async (request, reply) =>
      relay(
        request,
        reply,
        { admin: true, parse: () => parseInput(OrgRoleBodySchema, request.body, reply) },
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
        relay(request, reply, { admin: true }, async (orgId, _body, subjectDeps) => {
          // Deactivation is already org-scoped upstream (posts to the org
          // path, not a team path) — reuse it unchanged.
          await setWorkspaceMemberActivation(
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
