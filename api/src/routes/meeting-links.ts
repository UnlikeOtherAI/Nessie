import type { FastifyInstance } from 'fastify'
import {
  CallLinkError,
  CallLinkProviderSchema,
  createCallLinkForTeamUser,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const CreateMeetingLinkBodySchema = z.object({
  teamId: z.string().uuid(),
  provider: CallLinkProviderSchema.optional(),
}).strict()

const sendCallLinkError = (
  reply: Parameters<typeof sendApiError>[0],
  error: CallLinkError,
): void => {
  if (error.code === 'TEAM_NOT_FOUND') {
    sendApiError(reply, 404, error.code, 'Team not found')
    return
  }
  if (error.code === 'MEET_LINK_FAILED') {
    sendApiError(reply, 502, error.code, 'Google Meet could not create a link')
    return
  }
  const messages: Record<Exclude<typeof error.code, 'TEAM_NOT_FOUND' | 'MEET_LINK_FAILED'>, string> = {
    GOOGLE_NOT_CONNECTED: 'Connect Google before creating a Meet link',
    MEET_SCOPE_MISSING: 'Reconnect Google and grant the Meet space scope',
    GOOGLE_REAUTH_REQUIRED: 'Reconnect Google before creating a Meet link',
    PROVIDER_NOT_CONFIGURED: 'The selected call provider is not configured',
  }
  sendApiError(reply, 409, error.code, messages[error.code])
}

export const registerMeetingLinkRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { authSecret, prisma, requireActorContext, requireUserActor } = deps

  // Deliberately machine-only in Slice 1. The in-product call flow and the
  // mirrored personal-assistant tool are the planned doorways in later slices.
  app.post('/api/meetings/links', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const body = parseInput(CreateMeetingLinkBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const result = await createCallLinkForTeamUser(
        prisma,
        {
          teamId: body.teamId,
          userId: actorContext.actor.actorId,
          ...(body.provider ? { provider: body.provider } : {}),
        },
        { encryptionSecret: authSecret },
      )
      return reply.code(201).send(createApiResponse(result))
    } catch (error) {
      if (error instanceof CallLinkError) {
        sendCallLinkError(reply, error)
        return reply
      }
      throw error
    }
  })
}
