import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { verifySessionToken } from '../auth/session.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  acceptWorkspaceInvitation,
  UoaInvitationAlreadyAcceptedError,
  UoaInvitationOrgConflictError,
  UoaRosterRejectedError,
  UoaRosterUnavailableError,
  type UoaRosterDeps,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

const AcceptWorkspaceInvitationBodySchema = z.object({
  organizationId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
}).strict()

const ORG_CONFLICT_MESSAGE =
  "You already belong to another organisation on this workspace's domain, so this invitation cannot be accepted. Ask the inviter's organisation owner, or contact support."

const NOT_ACCEPTABLE_MESSAGE =
  'This invitation can no longer be accepted. It may already have been accepted, revoked, or expired.'

export const registerWorkspaceInvitationAcceptanceRoute = (
  app: FastifyInstance,
  deps: RouteDeps,
  rosterDeps: UoaRosterDeps = {},
): void => {
  app.post<{ Params: { inviteId: string } }>(
    '/api/workspace/invitations/:inviteId/accept',
    async (request, reply) => {
      const actorContext = deps.requireActorContext(request, reply)
      if (!actorContext) return reply

      const token = deps.getAuthorizationToken(request)
      const verification = token ? verifySessionToken(token, deps.authSecret) : null
      if (!verification?.ok || verification.claims.providerType !== 'uoa') {
        sendApiError(
          reply,
          403,
          'UOA_SESSION_REQUIRED',
          'Sign in with UnlikeOtherAI to accept this workspace invitation.',
        )
        return reply
      }

      const user = await deps.prisma.user.findUnique({
        where: { id: actorContext.actor.actorId },
        select: { uoaSub: true },
      })
      if (!user?.uoaSub) {
        sendApiError(
          reply,
          403,
          'UOA_SESSION_REQUIRED',
          'Your Nessie account is not linked to an UnlikeOtherAI identity.',
        )
        return reply
      }

      const body = parseInput(AcceptWorkspaceInvitationBodySchema, request.body, reply)
      if (!body) return reply
      const inviteId = request.params.inviteId.trim()
      if (!inviteId) {
        sendApiError(reply, 400, 'INVITATION_NOT_ACCEPTABLE', NOT_ACCEPTABLE_MESSAGE)
        return reply
      }

      try {
        await acceptWorkspaceInvitation(
          {
            externalOrgId: body.organizationId,
            externalTeamId: body.teamId,
          },
          inviteId,
          user.uoaSub,
          rosterDeps,
        )
      } catch (error) {
        if (error instanceof UoaInvitationOrgConflictError) {
          sendApiError(reply, 409, 'INVITATION_ORG_CONFLICT', ORG_CONFLICT_MESSAGE)
          return reply
        }
        if (
          error instanceof UoaInvitationAlreadyAcceptedError
          || error instanceof UoaRosterRejectedError
        ) {
          const status = error instanceof UoaRosterRejectedError && error.statusCode === 409
            ? 409
            : 400
          sendApiError(reply, status, 'INVITATION_NOT_ACCEPTABLE', NOT_ACCEPTABLE_MESSAGE)
          return reply
        }
        if (error instanceof UoaRosterUnavailableError) {
          request.log.warn({ err: error }, 'uoa workspace invitation acceptance failed')
          sendApiError(
            reply,
            503,
            'UOA_DIRECTORY_UNAVAILABLE',
            'The UnlikeOtherAI invitation service is temporarily unavailable.',
          )
          return reply
        }
        throw error
      }

      try {
        await deps.prisma.userAlert.deleteMany({
          where: {
            eventKey: `workspace-invite:${inviteId}`,
            kind: 'workspace_invitation',
            userId: actorContext.actor.actorId,
          },
        })
      } catch (error) {
        request.log.warn({ err: error }, 'accepted workspace invitation alert cleanup failed')
      }

      return createApiResponse({
        ok: true,
        organizationId: body.organizationId,
        teamId: body.teamId,
      })
    },
  )
}
