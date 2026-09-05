import type { FastifyInstance, FastifyReply } from 'fastify'

import { AddChannelMemberBodySchema } from '../contracts.js'
import { parseInput, sendApiError } from '../lib/api.js'
import {
  addMemberToChannel,
  removeMemberFromChannel,
  type ChannelMemberChange,
} from '../services/channel-members.js'
import type { RouteDeps } from './types.js'

// Both membership writes answer with the same union, so the mapping from a
// service decision to a status code is written once.
const sendChannelMemberRefusal = (
  reply: FastifyReply,
  result: Exclude<ChannelMemberChange, { kind: 'changed' }>,
): void => {
  switch (result.kind) {
    case 'channel_not_found':
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', 'Channel not found')
      return
    case 'system_managed':
      sendApiError(
        reply,
        403,
        'CHANNEL_SYSTEM_MANAGED',
        'System-managed conversations cannot be modified',
      )
      return
    case 'dm_members_fixed':
      // A DM is a fixed pair. Adding a third participant would either mutate a
      // private two-person history into something its participants never agreed
      // to, or silently fork it into a different channel; removing one half
      // would leave a conversation with nobody in it.
      sendApiError(
        reply,
        403,
        'CHANNEL_DM_MEMBERS_FIXED',
        'Direct messages are between two participants and cannot be changed. '
        + 'Create a channel to include more people.',
      )
      return
    case 'forbidden':
      sendApiError(
        reply,
        403,
        'CHANNEL_FORBIDDEN',
        'Only a channel, team or organisation administrator can change who is in this channel.',
      )
      return
    case 'target_not_in_organization':
      sendApiError(
        reply,
        403,
        'USER_NOT_IN_ORGANIZATION',
        'Target user is not a member of this organization',
      )
  }
}

/**
 * Who is in a channel. Registered by `registerChannelRoutes` beside the
 * channel's own lifecycle, kept in its own module because the authorization
 * these two writes take — `canManageChannel`, with a carve-out for leaving —
 * is the channel surface's one genuinely distinct decision.
 */
export const registerChannelMemberRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  // Adding somebody to a channel hands them its whole history, so the gate is
  // `canManageChannel` — the same one rename and archive take.
  app.post('/api/channels/:channelId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId } = request.params as { channelId: string }
    const body = parseInput(AddChannelMemberBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    const result = await addMemberToChannel(prisma, actorContext, {
      channelId,
      userId: body.userId,
    })
    if (result.kind !== 'changed') {
      sendChannelMemberRefusal(reply, result)
      return reply
    }
    return reply.code(204).send()
  })

  // Same gate as the add path, with one carve-out: a person may always remove
  // themselves from a channel they are in.
  app.delete('/api/channels/:channelId/members/:userId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { channelId, userId } = request.params as { channelId: string; userId: string }
    const result = await removeMemberFromChannel(prisma, actorContext, { channelId, userId })
    if (result.kind !== 'changed') {
      sendChannelMemberRefusal(reply, result)
      return reply
    }
    return reply.code(204).send()
  })
}
