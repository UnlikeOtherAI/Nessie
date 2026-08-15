import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createWorkspaceInvitations,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  removeWorkspaceMember,
  resendWorkspaceInvitation,
  resolveUoaRosterWorkspace,
  reviewWorkspaceInvitation,
  setWorkspaceMemberActivation,
  updateWorkspaceMemberRole,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  type UoaRosterDeps,
  type UoaRosterWorkspace,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The workspace roster and its invitations, served straight from UnlikeOtherAI.
 * Nessie persists none of it: UOA owns human identity, membership and
 * invitations, and invitation acceptance is hosted by UOA — there is no accept
 * flow here.
 *
 * People are named by their **UOA subject** in the path. Never a local user id
 * and never an email lookup against local rows: the subject is the only stable
 * identifier, and matching on an email an IdP asserts is the documented
 * account-takeover shape.
 *
 * `/org/*` in backend mode carries no acting user, so UOA applies **no** role
 * check and records the mutation as `via: "domain_backend"`. The owner/admin
 * gate below is therefore load-bearing, exactly as on the workspace avatar
 * relay. `actor.roles` is re-resolved from the live `OrganizationMember` row on
 * every request (`lib/server-context.ts`), so it is safe to gate on.
 */

const ADMIN_ROLES = new Set(['owner', 'admin'])

const NOT_LINKED_MESSAGE =
  'This workspace is not linked to an UnlikeOtherAI workspace'

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

const requireWorkspace = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): Promise<UoaRosterWorkspace | null> => {
  const workspace = await resolveUoaRosterWorkspace(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
  })
  if (!workspace) {
    sendApiError(reply, 404, 'WORKSPACE_NOT_LINKED', NOT_LINKED_MESSAGE)
    return null
  }
  return workspace
}

const requireWorkspaceAdmin = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): boolean => {
  const allowed = actorContext.actor.actorType === 'user'
    && (actorContext.actor.roles ?? []).some((role) => ADMIN_ROLES.has(role))
  if (!allowed) {
    sendApiError(
      reply,
      403,
      'FORBIDDEN',
      'Only organisation owners and admins can change workspace membership',
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
  if (error instanceof UoaRosterRejectedError) {
    sendApiError(
      reply,
      error.statusCode === 404 ? 404 : 400,
      'WORKSPACE_MEMBERS_REJECTED',
      'UnlikeOtherAI refused the request. The member or invitation may no longer exist.',
    )
    return true
  }
  if (error instanceof UoaRosterUnavailableError) {
    request.log.warn({ err: error }, 'uoa workspace roster relay failed')
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
export const registerWorkspaceMembersRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const { requireActorContext } = deps

  /**
   * Run one relayed operation behind the shared preconditions, in order:
   * authorization, then body validation, then the workspace lookup, then the
   * relay. `admin` picks the gate — the roster read is visible to any member of
   * the workspace, everything else is owner/admin — and `parse` is the route's
   * body schema, applied after the gate so an unauthorized caller learns
   * nothing about the payload.
   */
  const relay = async <TResult, TBody = undefined>(
    request: FastifyRequest,
    reply: FastifyReply,
    options: { admin: boolean; parse?: () => TBody | null },
    run: (workspace: UoaRosterWorkspace, body: TBody) => Promise<TResult>,
  ): Promise<FastifyReply | { data: TResult }> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (options.admin && !requireWorkspaceAdmin(actorContext, reply)) return reply

    const body = options.parse ? options.parse() : (undefined as TBody)
    if (body === null) return reply

    const workspace = await requireWorkspace(deps, actorContext, reply)
    if (!workspace) return reply

    try {
      return createApiResponse(await run(workspace, body as TBody))
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }
  }

  app.get('/api/workspace/members', async (request, reply) =>
    relay(request, reply, { admin: false }, async (workspace) => ({
      members: await listWorkspaceMembers(workspace, rosterDeps),
    })))

  app.put<{ Params: { uoaSub: string } }>(
    '/api/workspace/members/:uoaSub/role',
    async (request, reply) =>
      relay(
        request,
        reply,
        { admin: true, parse: () => parseInput(TeamRoleBodySchema, request.body, reply) },
        async (workspace, body) => {
          await updateWorkspaceMemberRole(workspace, request.params.uoaSub, body.role, rosterDeps)
          return { ok: true }
        },
      ),
  )

  app.delete<{ Params: { uoaSub: string } }>(
    '/api/workspace/members/:uoaSub',
    async (request, reply) =>
      relay(request, reply, { admin: true }, async (workspace) => {
        await removeWorkspaceMember(workspace, request.params.uoaSub, rosterDeps)
        return { ok: true }
      }),
  )

  for (const action of ['deactivate', 'reactivate'] as const) {
    app.post<{ Params: { uoaSub: string } }>(
      `/api/workspace/members/:uoaSub/${action}`,
      async (request, reply) =>
        relay(request, reply, { admin: true }, async (workspace) => {
          await setWorkspaceMemberActivation(
            workspace,
            request.params.uoaSub,
            action,
            rosterDeps,
          )
          return { ok: true }
        }),
    )
  }

  // Invitation emails are PII; UOA gates its own invited list to owners/admins
  // and so does this route.
  app.get('/api/workspace/invitations', async (request, reply) =>
    relay(request, reply, { admin: true }, async (workspace) => ({
      invitations: await listWorkspaceInvitations(workspace, rosterDeps),
    })))

  app.post('/api/workspace/invitations', async (request, reply) =>
    relay(
      request,
      reply,
      { admin: true, parse: () => parseInput(CreateInvitationsBodySchema, request.body, reply) },
      async (workspace, body) => ({
        results: await createWorkspaceInvitations(workspace, body, rosterDeps),
      }),
    ))

  app.post<{ Params: { inviteId: string } }>(
    '/api/workspace/invitations/:inviteId/resend',
    async (request, reply) =>
      relay(request, reply, { admin: true }, async (workspace) => {
        await resendWorkspaceInvitation(workspace, request.params.inviteId, rosterDeps)
        return { ok: true }
      }),
  )

  // approve sends the invitation email; deny is UOA's only stop verb — there is
  // no cancel or delete for an invitation that has already been sent.
  for (const action of ['approve', 'deny'] as const) {
    app.post<{ Params: { inviteId: string } }>(
      `/api/workspace/invitations/:inviteId/${action}`,
      async (request, reply) =>
        relay(request, reply, { admin: true }, async (workspace) => {
          await reviewWorkspaceInvitation(
            workspace,
            request.params.inviteId,
            action,
            rosterDeps,
          )
          return { ok: true }
        }),
    )
  }
}
