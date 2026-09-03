import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  CallLinkProviderSchema,
  createTeamForUser,
  isCallLinkProviderConfigured,
  listTeamsForOrganization,
  ProjectValidationError,
  type CallLinkProvider,
} from '@nessie/team-admin'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { renameCachedUoaTeam } from '../services/uoa-directory-cache.js'
import {
  renameUoaTeam,
  resolveUoaRosterTeam,
  UoaRosterIdentityError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import { mirrorExternalTeamName } from '../services/team-target.js'
import { requireLocalMembershipManagement } from './membership-mode-gate.js'
import type { RouteDeps } from './types.js'

/**
 * Renaming a team whose name UOA owns is a write to UOA, not to the local
 * mirror.
 *
 * A UOA team maps 1:1 onto a Team and UOA is the authority for its name;
 * `Team.name` (and the fabricated Project beside it) is a non-authoritative
 * mirror that `syncExternalTeamNames` heals from UOA's verified directory.
 * A local-only write would be the second copy of the org structure the SSO
 * invariant forbids, and the next roster read would revert it — which is why
 * this route used to answer `409 TEAM_NAME_OWNED_BY_IDP` and send people to
 * UOA's own admin to rename their team. It now relays instead: UOA stays
 * the authority, and the local mirror is written from the record UOA echoes,
 * so the two agree by construction. A refusal or an outage upstream changes
 * nothing locally. A local install with no IdP (`externalTeamId` null)
 * owns its own names and still writes directly.
 */
const RenameTeamBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
}).strict()

const UpdateTeamSettingsBodySchema = z.object({
  callProvider: CallLinkProviderSchema,
}).strict()

const configuredCallProviders = (): Record<CallLinkProvider, boolean> => ({
  google_meet: isCallLinkProviderConfigured('google_meet'),
  jitsi: isCallLinkProviderConfigured('jitsi'),
  microsoft_teams: isCallLinkProviderConfigured('microsoft_teams'),
})

/**
 * `rosterDeps` is the injectable egress seam (pinned fetch + DNS) for the one
 * upstream call this file makes — renaming a UOA-bound team. Production
 * passes nothing; it mirrors `registerOrganizationRoutes`.
 */
export const registerTeamRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  const {
    config,
    prisma,
    requireActorContext,
    requireOwner,
    resolveMembershipRole,
    MEMBERSHIP_ROLES,
  } = deps

  const UOA_SESSION_MESSAGE =
    'This team is managed by UnlikeOtherAI. Sign in with UnlikeOtherAI and select this '
    + 'team to rename it.'

  /**
   * Relay a team rename to UnlikeOtherAI and answer with the name UOA
   * stored, or `null` once a refusal has been written to `reply`.
   *
   * The assertion UOA verifies names the caller's active org AND team, and UOA
   * additionally requires the asserted team to equal the one in the route,
   * so this can only ever rename the team the caller is standing in. That
   * is also the local entitlement rule: the owner/admin gate above was resolved
   * against the session's organisation.
   */
  const renameOnUnlikeOtherAI = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: { actorContext: AuthorizedActionContext; name: string; teamId: string },
  ): Promise<string | null> => {
    const team = await resolveUoaRosterTeam(prisma, {
      organizationId: input.actorContext.tenant.organizationId,
      teamId: input.teamId,
    })
    if (!team) {
      sendApiError(reply, 403, 'UOA_SESSION_REQUIRED', UOA_SESSION_MESSAGE)
      return null
    }

    try {
      return await renameUoaTeam(
        team,
        input.name,
        withUoaRosterSubjectAssertion(
          team,
          input.actorContext.actionContext.uoaIdentity,
          rosterDeps,
        ),
      )
    } catch (error) {
      if (error instanceof UoaRosterIdentityError) {
        sendApiError(reply, 403, 'UOA_SESSION_REQUIRED', UOA_SESSION_MESSAGE)
        return null
      }
      if (error instanceof UoaRosterRejectedError) {
        // UOA re-resolves the caller's live `teams.manage` capability and its
        // own name rules, so its refusal is the answer — never a reason to
        // write locally.
        sendApiError(
          reply,
          error.statusCode === 403 || error.statusCode === 404 ? error.statusCode : 400,
          'TEAM_RENAME_REJECTED',
          'UnlikeOtherAI refused the rename. You may not have permission to rename this '
            + 'team there.',
        )
        return null
      }
      if (error instanceof UoaRosterUnavailableError) {
        request.log.warn({ err: error }, 'uoa team rename relay failed')
        sendApiError(
          reply,
          502,
          'UOA_DIRECTORY_UNAVAILABLE',
          'The UnlikeOtherAI directory is temporarily unavailable',
        )
        return null
      }
      throw error
    }
  }

  app.get('/api/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as { projectId?: string }
    // The shared reader, so the `project_list` tool resolves a team name to the
    // same ids this page shows. Provider *availability* is a deployment fact the
    // API owns, so it is decorated here rather than baked into the record.
    const teams = await listTeamsForOrganization(prisma, {
      organizationId: actorContext.tenant.organizationId,
      ...(query.projectId ? { projectIds: [query.projectId] } : {}),
    })

    const callProviderAvailability = configuredCallProviders()

    return createApiResponse(teams.map((team) => ({
      ...team,
      callProviderAvailability,
    })))
  })

  app.post('/api/teams', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = request.body as { name?: string; projectId?: string } | undefined
    if (!body?.name || !body?.projectId) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'name and projectId are required')
      return reply
    }

    // The same function the `team_create` tool calls, including the
    // project-belongs-to-this-organisation check behind the 404.
    let team
    try {
      team = await createTeamForUser(prisma, {
        name: body.name,
        organizationId: actorContext.tenant.organizationId,
        projectId: body.projectId,
        userId: actorContext.actor.actorId,
      })
    } catch (error) {
      if (error instanceof ProjectValidationError) {
        sendApiError(reply, 400, 'INVALID_INPUT', error.message)
        return reply
      }
      throw error
    }
    if (!team) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Project not found')
      return reply
    }

    await emitAuditEvent(prisma, {
      actorContext,
      action: 'team.created' as Parameters<typeof emitAuditEvent>[1]['action'],
      resourceType: 'team',
      resourceId: team.id,
      outcome: 'success',
    })

    return reply.code(201).send(createApiResponse({
      ...team,
      callProviderAvailability: configuredCallProviders(),
    }))
  })

  app.post('/api/teams/:teamId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply
    if (!requireLocalMembershipManagement(config.mode, reply)) return reply

    const { teamId } = request.params as { teamId: string }
    const body = request.body as { userId?: string; role?: string } | undefined
    if (!body?.userId) {
      sendApiError(reply, 400, 'USER_ID_REQUIRED', 'userId is required')
      return reply
    }

    const role = resolveMembershipRole(body.role)
    if (!role) {
      sendApiError(reply, 400, 'INVALID_ROLE', `role must be one of: ${MEMBERSHIP_ROLES.join(', ')}`)
      return reply
    }

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { project: true },
    })
    if (
      !team
      || team.systemManaged
      || team.project.channelRoot
      || team.project.organizationId !== actorContext.tenant.organizationId
    ) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
      return reply
    }

    // `userId` is raw request body. Confirm it belongs to this organisation so a
    // foreign-tenant id cannot be written into the membership table.
    const targetIsOrgMember = await prisma.organizationMember.count({
      where: {
        organizationId: actorContext.tenant.organizationId,
        userId: body.userId,
      },
    })
    if (targetIsOrgMember === 0) {
      sendApiError(reply, 404, 'USER_NOT_FOUND', 'User is not a member of this organization')
      return reply
    }

    await prisma.teamMember.create({
      data: {
        teamId,
        userId: body.userId,
        role,
      },
    })

    return reply.code(201).send(createApiResponse({ ok: true }))
  })

  app.patch('/api/teams/:teamId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const roles = actorContext.actor.roles ?? []
    if (!roles.includes('owner') && !roles.includes('admin')) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
      return reply
    }

    const body = parseInput(RenameTeamBodySchema, request.body, reply)
    if (!body) return reply

    const { teamId } = request.params as { teamId: string }
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        project: { organizationId: actorContext.tenant.organizationId },
      },
      select: { externalTeamId: true, id: true },
    })
    if (!team) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
      return reply
    }

    // UOA first, then the mirror: see the note on RenameTeamBodySchema. A
    // local-mode team resolves to the requested name with no upstream call.
    const stored = team.externalTeamId
      ? await renameOnUnlikeOtherAI(request, reply, {
        actorContext,
        name: body.name,
        teamId: team.id,
      })
      : body.name
    if (stored === null) return reply

    if (team.externalTeamId) {
      // Both rows carry the team label, so heal them exactly as the
      // directory sync would rather than leaving the Project on the old name.
      await mirrorExternalTeamName(prisma, team.externalTeamId, stored)
      // The switcher reads its labels from the cached UOA directory, so a
      // rename that did not reach it would show the old name until the next
      // rotation — the team a person renamed while looking at it.
      renameCachedUoaTeam(
        actorContext.actor.actorId,
        team.externalTeamId,
        stored,
      )
      return createApiResponse({ id: team.id, name: stored })
    }

    const updated = await prisma.team.update({
      data: { name: stored },
      where: { id: team.id },
      select: { id: true, name: true },
    })
    return createApiResponse(updated)
  })

  app.patch('/api/teams/:teamId/settings', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const roles = actorContext.actor.roles ?? []
    if (!roles.includes('owner') && !roles.includes('admin')) {
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
      return reply
    }

    const body = parseInput(UpdateTeamSettingsBodySchema, request.body, reply)
    if (!body) return reply
    if (!isCallLinkProviderConfigured(body.callProvider)) {
      sendApiError(
        reply,
        409,
        'PROVIDER_NOT_CONFIGURED',
        `The ${body.callProvider} call provider is not configured`,
      )
      return reply
    }

    const { teamId } = request.params as { teamId: string }
    const team = await prisma.team.findFirst({
      where: {
        id: teamId,
        project: { organizationId: actorContext.tenant.organizationId },
      },
      select: { id: true },
    })
    if (!team) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Team not found')
      return reply
    }

    const updated = await prisma.team.update({
      where: { id: team.id },
      data: { callProvider: body.callProvider },
      select: { id: true, callProvider: true },
    })
    return createApiResponse(updated)
  })
}
