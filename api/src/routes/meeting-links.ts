import type { FastifyInstance } from 'fastify'
import {
  CallLinkError,
  CallLinkProviderSchema,
  createCallLinkForTeamUser,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import { createApiResponse, parseInput } from '../lib/api.js'
import { sendCallLinkError } from './call-link-error.js'
import type { RouteDeps } from './types.js'

const CreateMeetingLinkBodySchema = z.object({
  teamId: z.string().uuid(),
  provider: CallLinkProviderSchema.optional(),
}).strict()

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
