import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { AVATAR_CACHE_CONTROL, sendAvatarImage, sendAvatarNotFound } from './avatar-response.js'
import {
  fetchUoaUserAvatar,
  UoaAvatarUnavailableError,
  type UoaAvatarImage,
} from '../services/uoa-avatar.js'
import { isTeamRosterSubject } from '../services/uoa-roster-subjects.js'
import {
  createTeamInvitations,
  listTeamInvitations,
  listTeamMembers,
  removeTeamMember,
  resendTeamInvitation,
  resolveLocalUserIdsByUoaSub,
  resolveUoaRosterTeam,
  revokeTeamInvitation,
  reviewTeamInvitation,
  setTeamMemberActivation,
  updateTeamMemberRole,
  UoaInvitationAlreadyAcceptedError,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
  type UoaRosterTeam,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The team roster and its invitations, served straight from UnlikeOtherAI.
 * Nessie persists none of it: UOA owns human identity, membership and
 * invitations, and invitation acceptance is hosted by UOA — there is no accept
 * flow here.
 *
 * People are named by their **UOA subject** in the path. Never a local user id
 * and never an email lookup against local rows: the subject is the only stable
 * identifier, and matching on an email an IdP asserts is the documented
 * account-takeover shape.
 *
 * Their pictures are relayed here too (`/members/:uoaSub/avatar`), for the same
 * reason: UOA's member records carry an avatar URL that needs the domain-hash
 * bearer, and the user-id-keyed relay in `routes/users.ts` cannot name somebody
 * who has no local row.
 *
 * Every `/org/*` call carries a short-lived assertion of the signed-in UOA
 * subject. UOA re-resolves that person's credential epoch and membership, then
 * applies its own role/capability rules. The owner/admin gate below remains the
 * local entitlement check before we send a mutation upstream; `actor.roles` is
 * re-resolved from the live `OrganizationMember` row on every request
 * (`lib/server-context.ts`).
 */

const NOT_LINKED_MESSAGE =
  'This team is not linked to an UnlikeOtherAI team'

const NOT_IN_TEAM_MESSAGE =
  'This person has no UnlikeOtherAI avatar in this team'

// UOA's own vocabulary for a team role. "owner" is a transfer-ownership
// operation upstream, not a role write, so it is not offered here.
const TeamRoleBodySchema = z.object({
  role: z.enum(['admin', 'member']),
})

const CreateInvitationsBodySchema = z.object({
  invites: z
    .array(
      z.object({
        email: z.string().trim().email().max(320),
        name: z.string().trim().min(1).max(200).optional(),
        teamRole: z.enum(['admin', 'member']).optional(),
      }),
    )
    .min(1)
    .max(200),
})

const requireTeam = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
  options: { cacheableMiss?: boolean } = {},
): Promise<UoaRosterTeam | null> => {
  const team = await resolveUoaRosterTeam(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
  })
  if (!team) {
    // The avatar relay's misses are cacheable like every other avatar relay's:
    // the browser re-asks on each mount and the answer will not change soon.
    if (options.cacheableMiss) reply.header('cache-control', AVATAR_CACHE_CONTROL)
    sendApiError(reply, 404, 'TEAM_NOT_LINKED', NOT_LINKED_MESSAGE)
    return null
  }
  return team
}

const requireTeamAdmin = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): boolean => {
  const allowed = actorContext.actor.actorType === 'user' && isAdminActor(actorContext)
  if (!allowed) {
    sendApiError(
      reply,
      403,
      'FORBIDDEN',
      'Only organisation owners and admins can change team membership',
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
      'TEAM_MEMBERS_REJECTED',
      'UnlikeOtherAI refused the request. The member or invitation may no longer exist.',
    )
    return true
  }
  if (error instanceof UoaRosterIdentityError) {
    sendApiError(
      reply,
      403,
      'UOA_SESSION_REQUIRED',
      'Sign in with UnlikeOtherAI and select this team to view its members.',
    )
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa team roster relay failed')
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
 * `rosterDeps` is the injectable egress seam (pinned fetch + DNS), the same one
 * `services/uoa-org-roster.ts` takes. Production passes nothing.
 */
export const registerTeamMembersRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { requireActorContext } = deps

  /**
   * Run one relayed operation behind the shared preconditions, in order:
   * authorization, then body validation, then the team lookup, then the
   * relay. `admin` picks the gate — the roster read is visible to any member of
   * the team, everything else is owner/admin — and `parse` is the route's
   * body schema, applied after the gate so an unauthorized caller learns
   * nothing about the payload.
   */
  const relay = async <TResult, TBody = undefined>(
    request: FastifyRequest,
    reply: FastifyReply,
    options: { admin: boolean; parse?: () => TBody | null },
    run: (
      team: UoaRosterTeam,
      body: TBody,
      actorContext: AuthorizedActionContext,
      subjectDeps: UoaRosterDeps,
    ) => Promise<TResult>,
  ): Promise<FastifyReply | { data: TResult }> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (options.admin && !requireTeamAdmin(actorContext, reply)) return reply

    const body = options.parse ? options.parse() : (undefined as TBody)
    if (body === null) return reply

    const team = await requireTeam(deps, actorContext, reply)
    if (!team) return reply

    try {
      return createApiResponse(await run(
        team,
        body as TBody,
        actorContext,
        withUoaRosterSubjectAssertion(
          team,
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
   * The roster, with each person's local principal id attached where one
   * exists. The id is resolved org-scoped (`resolveLocalUserIdsByUoaSub`) and
   * is what lets the Members page show each person beside the agents they
   * steward, without Nessie storing any second copy of UOA's roster.
   */
  app.get('/api/team/members', async (request, reply) =>
    relay(request, reply, { admin: false }, async (team, _body, actorContext, subjectDeps) => {
      const members = await listTeamMembers(team, subjectDeps)
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

  /**
   * The picture UOA holds for one person in this team's roster. Same
   * entitlement as the roster read itself — a roster row is only a UOA subject,
   * so `GET /api/users/:userId/avatar` (keyed by a Nessie user id) cannot serve
   * people who have no local row.
   *
   * The roster-membership check is load-bearing, not a formality: UOA's
   * `/domain/users/:sub/avatar` answers for **any** subject the domain hash can
   * see, so relaying without it would hand any member the picture of anybody in
   * the whole UOA domain, one guessed subject at a time. It reuses the roster
   * read the Members page is served from, briefly cached per team.
   */
  app.get<{ Params: { uoaSub: string } }>(
    '/api/team/members/:uoaSub/avatar',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const team = await requireTeam(deps, actorContext, reply, {
        cacheableMiss: true,
      })
      if (!team) return reply

      const { uoaSub } = request.params
      let image: UoaAvatarImage | null = null
      try {
        if (!(await isTeamRosterSubject(team, uoaSub, rosterDeps))) {
          // Deliberately the same answer as "this person has no picture": a
          // caller learns nothing about subjects outside their team.
          return sendAvatarNotFound(reply, NOT_IN_TEAM_MESSAGE)
        }
        image = await fetchUoaUserAvatar(uoaSub, rosterDeps)
      } catch (error) {
        if (sendRelayError(request, reply, error)) return reply
        if (error instanceof UoaAvatarUnavailableError) {
          request.log.warn({ err: error }, 'uoa team member avatar relay failed')
          sendApiError(
            reply,
            502,
            'UOA_AVATAR_UNAVAILABLE',
            'The UnlikeOtherAI avatar service is temporarily unavailable',
          )
          return reply
        }
        throw error
      }

      if (!image) {
        return sendAvatarNotFound(reply, NOT_IN_TEAM_MESSAGE)
      }
      return sendAvatarImage(reply, image)
    },
  )

  app.put<{ Params: { uoaSub: string } }>(
    '/api/team/members/:uoaSub/role',
    async (request, reply) =>
      relay(
        request,
        reply,
        { admin: true, parse: () => parseInput(TeamRoleBodySchema, request.body, reply) },
        async (team, body, _actorContext, subjectDeps) => {
          await updateTeamMemberRole(team, request.params.uoaSub, body.role, subjectDeps)
          return { ok: true }
        },
      ),
  )

  app.delete<{ Params: { uoaSub: string } }>(
    '/api/team/members/:uoaSub',
    async (request, reply) =>
      relay(request, reply, { admin: true }, async (team, _body, _actorContext, subjectDeps) => {
        await removeTeamMember(team, request.params.uoaSub, subjectDeps)
        return { ok: true }
      }),
  )

  for (const action of ['deactivate', 'reactivate'] as const) {
    app.post<{ Params: { uoaSub: string } }>(
      `/api/team/members/:uoaSub/${action}`,
      async (request, reply) =>
        relay(request, reply, { admin: true }, async (team, _body, _actorContext, subjectDeps) => {
          await setTeamMemberActivation(
            team,
            request.params.uoaSub,
            action,
            subjectDeps,
          )
          return { ok: true }
        }),
    )
  }

  // Invitation emails are PII; UOA gates its own invited list to owners/admins
  // and so does this route.
  app.get('/api/team/invitations', async (request, reply) =>
    relay(request, reply, { admin: true }, async (team, _body, _actorContext, subjectDeps) => ({
      invitations: await listTeamInvitations(team, subjectDeps),
    })))

  app.post('/api/team/invitations', async (request, reply) =>
    relay(
      request,
      reply,
      { admin: true, parse: () => parseInput(CreateInvitationsBodySchema, request.body, reply) },
      async (team, body, _actorContext, subjectDeps) => ({
        results: await createTeamInvitations(team, body, subjectDeps),
      }),
    ))

  app.post<{ Params: { inviteId: string } }>(
    '/api/team/invitations/:inviteId/resend',
    async (request, reply) =>
      relay(request, reply, { admin: true }, async (team, _body, _actorContext, subjectDeps) => {
        await resendTeamInvitation(team, request.params.inviteId, subjectDeps)
        return { ok: true }
      }),
  )

  /**
   * Withdraw an invitation that was already sent. Revoking twice succeeds —
   * UOA's delete is idempotent — but an invitation that has already been
   * accepted answers `409 INVITATION_ALREADY_ACCEPTED`: that person is a member
   * now, and removing them is a different decision.
   */
  app.post<{ Params: { inviteId: string } }>(
    '/api/team/invitations/:inviteId/revoke',
    async (request, reply) =>
      relay(request, reply, { admin: true }, async (team, _body, _actorContext, subjectDeps) => {
        await revokeTeamInvitation(team, request.params.inviteId, subjectDeps)
        return { ok: true }
      }),
  )

  // approve sends the invitation email; deny is the review verb for an invite
  // that was never sent. Withdrawing a sent one is `/revoke`, above.
  for (const action of ['approve', 'deny'] as const) {
    app.post<{ Params: { inviteId: string } }>(
      `/api/team/invitations/:inviteId/${action}`,
      async (request, reply) =>
        relay(request, reply, { admin: true }, async (team, _body, _actorContext, subjectDeps) => {
          await reviewTeamInvitation(
            team,
            request.params.inviteId,
            action,
            subjectDeps,
          )
          return { ok: true }
        }),
    )
  }
}
