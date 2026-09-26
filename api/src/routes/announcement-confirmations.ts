import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  AnnouncementAccessUnavailableError,
  getOwnConfirmationReceipt,
  getConfirmationStatus,
  requestConfirmationReminders,
  updateConfirmationReceipt,
} from '../services/announcement-confirmations.js'
import { sendAnnouncementAudienceError } from './announcement-audience-errors.js'
import type { RouteDeps } from './types.js'

export const registerAnnouncementConfirmationRoutes = (
  app: FastifyInstance, deps: RouteDeps,
): void => {
  app.get('/api/messages/:messageId/confirmation', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const id = z.string().uuid().safeParse((request.params as { messageId: string }).messageId)
    if (!id.success) return sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid message id')
    try {
      const receipt = await getOwnConfirmationReceipt(deps.prisma, actorContext, id.data)
      if (!receipt) return sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return createApiResponse(receipt)
    } catch (error) {
      if (error instanceof AnnouncementAccessUnavailableError) {
        return sendApiError(reply, 503, 'MEMBERSHIP_UNAVAILABLE', 'Membership could not be verified')
      }
      throw error
    }
  })
  for (const action of ['seen', 'acknowledge'] as const) {
    app.post(`/api/messages/:messageId/${action}`, async (request, reply) => {
      const actorContext = deps.requireActorContext(request, reply)
      if (!actorContext) return reply
      const id = z.string().uuid().safeParse((request.params as { messageId: string }).messageId)
      if (!id.success) return sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid message id')
      try {
        const result = await updateConfirmationReceipt(deps.prisma, actorContext, id.data, action)
        if (result === 'not_found') return sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
        if (result === 'forbidden') return sendApiError(reply, 403, 'CONFIRMATION_FORBIDDEN', 'You cannot confirm this announcement')
        return createApiResponse({ ok: true })
      } catch (error) {
        if (error instanceof AnnouncementAccessUnavailableError) {
          return sendApiError(reply, 503, 'MEMBERSHIP_UNAVAILABLE', 'Membership could not be verified')
        }
        throw error
      }
    })
  }

  app.get('/api/messages/:messageId/confirmation-status', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const id = z.string().uuid().safeParse((request.params as { messageId: string }).messageId)
    if (!id.success) return sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid message id')
    try {
      const status = await getConfirmationStatus(deps.prisma, actorContext, id.data)
      if (!status) return sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      if (status.forbidden) return sendApiError(reply, 403, 'CONFIRMATION_FORBIDDEN', 'Confirmation status is private')
      return createApiResponse(status)
    } catch (error) {
      if (sendAnnouncementAudienceError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/messages/:messageId/remind-unconfirmed', async (request, reply) => {
    const actorContext = deps.requireActorContext(request, reply)
    if (!actorContext) return reply
    const id = z.string().uuid().safeParse((request.params as { messageId: string }).messageId)
    if (!id.success) return sendApiError(reply, 400, 'VALIDATION_ERROR', 'Invalid message id')
    const count = await requestConfirmationReminders(deps.prisma, actorContext, id.data)
    if (count === 'not_found') return sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
    if (count === 'forbidden') return sendApiError(reply, 403, 'REMINDER_FORBIDDEN', 'Only the current administrator who posted this announcement can send reminders')
    return createApiResponse({ queued: count })
  })
}
