import type { FastifyInstance } from 'fastify'

import { CreateMailboxMessageBodySchema, MailboxMessageRecordSchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  claimMailboxMessage,
  createMailboxMessage,
  listMailboxMessages,
  markMailboxMessageDelivered,
} from '../services/mailbox.js'
import type { RouteDeps } from './types.js'

export const registerMailboxRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  app.get('/api/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const query = request.query as { planId?: string; toAgentId?: string }
    const messages = await listMailboxMessages(prisma, actorContext.tenant.organizationId, query)
    return createApiResponse(MailboxMessageRecordSchema.array().parse(messages))
  })

  app.post('/api/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const body = parseInput(CreateMailboxMessageBodySchema, request.body, reply)
    if (!body) {
      return reply
    }

    let message
    try {
      message = await createMailboxMessage(prisma, actorContext.tenant.organizationId, {
        ...body,
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'MAILBOX_THREAD_NOT_FOUND') {
        sendApiError(reply, 404, 'MAILBOX_THREAD_NOT_FOUND', 'Mailbox thread not found')
        return reply
      }
      if (error instanceof Error && error.message === 'MAILBOX_THREAD_CHANNEL_MISMATCH') {
        sendApiError(
          reply,
          400,
          'MAILBOX_THREAD_CHANNEL_MISMATCH',
          'Mailbox thread does not belong to the requested channel',
        )
        return reply
      }
      if (error instanceof Error && error.message === 'MAILBOX_CORRELATION_CONFLICT') {
        sendApiError(
          reply,
          409,
          'MAILBOX_CORRELATION_CONFLICT',
          'Correlation ID already belongs to a different mailbox message',
        )
        return reply
      }
      throw error
    }
    return reply.code(201).send(createApiResponse(MailboxMessageRecordSchema.parse(message)))
  })

  app.post('/api/mailbox/:messageId/deliver', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { messageId } = request.params as { messageId: string }
    const delivery = await markMailboxMessageDelivered(
      prisma,
      actorContext.tenant.organizationId,
      messageId,
    )
    if (delivery.kind === 'not_found') {
      sendApiError(reply, 404, 'MAILBOX_MESSAGE_NOT_FOUND', 'Mailbox message not found')
      return reply
    }
    if (delivery.kind === 'not_deliverable') {
      sendApiError(
        reply,
        409,
        'MAILBOX_MESSAGE_NOT_DELIVERABLE',
        'Mailbox message must be claimed before it can be marked delivered',
      )
      return reply
    }

    return createApiResponse(MailboxMessageRecordSchema.parse(delivery.message))
  })

  app.post('/api/mailbox/:messageId/claim', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (!requireOwner(actorContext, reply)) {
      return reply
    }

    const { messageId } = request.params as { messageId: string }
    const claim = await claimMailboxMessage(
      prisma,
      actorContext.tenant.organizationId,
      messageId,
    )
    if (claim.kind === 'not_found') {
      sendApiError(reply, 404, 'MAILBOX_MESSAGE_NOT_FOUND', 'Mailbox message not found')
      return reply
    }
    if (claim.kind === 'not_claimable') {
      sendApiError(
        reply,
        409,
        'MAILBOX_MESSAGE_NOT_CLAIMABLE',
        'Mailbox message is not currently claimable',
      )
      return reply
    }

    return createApiResponse(MailboxMessageRecordSchema.parse(claim.message))
  })
}
