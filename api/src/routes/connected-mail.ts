import {
  ConnectedMailComposeInputSchema,
  ConnectedMailDraftCreateInputSchema,
  ConnectedMailConversationParamsSchema,
  ConnectedMailGmailDraftSendInputSchema,
  ConnectedMailboxSendInputSchema,
  ConnectedMailSourceSchema,
  ConnectedMailThreadsQuerySchema,
} from '@nessie/schemas'
import {
  composeDraftForUser,
  ConnectedMailError,
  GmailDraftError,
  listConnectedMailAccounts,
  listConnectedMailThreads,
  readMailboxSendAction,
  readConnectedMailConversation,
  sendConnectedMailboxMail,
  sendDraftForUser,
  updateDraftForUser,
} from '@nessie/team-admin'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { isOriginAllowed } from '../lib/server-origin-policy.js'
import { emitAuditEvent } from '../services/audit.js'
import type { RouteDeps } from './types.js'

const AccountParamsSchema = z.object({
  accountId: z.string().min(1).max(200),
  source: ConnectedMailSourceSchema,
}).strict()

const DraftParamsSchema = AccountParamsSchema.extend({ draftId: z.string().uuid() }).strict()
const SendActionParamsSchema = AccountParamsSchema.extend({ actionId: z.string().uuid() }).strict()
const UNDO_WINDOW_MS = Number(process.env.NESSIE_GMAIL_UNDO_WINDOW_MS ?? 15_000)

const noStore = (reply: { header: (name: string, value: string) => unknown }): void => {
  reply.header('Cache-Control', 'private, no-store')
}

const connectedMailStatus = (error: ConnectedMailError): number => {
  if (error.code === 'NOT_FOUND') return 404
  if (error.code === 'CAPABILITY_UNSUPPORTED') return 409
  if (error.code === 'INVALID_RECIPIENT') return 400
  if (error.code === 'DELIVERY_REJECTED') return 422
  if (error.code === 'DELIVERY_UNKNOWN') return 409
  if (error.code === 'NEEDS_REAUTHORIZATION') return 401
  return 502
}

/** Cookie-authenticated provider writes reject cross-site and simple-form requests. */
const requireMailMutationRequest = (
  request: FastifyRequest,
  reply: Parameters<typeof sendApiError>[0],
  deps: RouteDeps,
): boolean => {
  const origin = deps.parseHeaderValue(request.headers.origin)
  if (!origin || !isOriginAllowed({
    allowedOrigins: deps.allowedCorsOrigins,
    mode: deps.config.mode,
    origin,
  })) {
    sendApiError(reply, 403, 'ORIGIN_FORBIDDEN', 'A permitted browser origin is required')
    return false
  }
  if (!deps.isJsonContentType(request)) {
    sendApiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json')
    return false
  }
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
    || Object.keys(request.body).length === 0) {
    sendApiError(reply, 400, 'VALIDATION_ERROR', 'A non-empty JSON body is required', 'body')
    return false
  }
  return true
}

export const registerConnectedMailRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps
  const serviceDeps = { encryptionSecret: deps.authSecret }
  const actor = (request: FastifyRequest, reply: Parameters<typeof sendApiError>[0]) => {
    const context = requireActorContext(request, reply)
    if (!context || !requireUserActor(context, reply)) return null
    return {
      context,
      mailActor: { organizationId: context.tenant.organizationId, userId: context.actor.actorId },
    }
  }
  const fail = (reply: Parameters<typeof sendApiError>[0], error: unknown) => {
    if (error instanceof ConnectedMailError) {
      sendApiError(
        reply, connectedMailStatus(error), error.code, 'Mail account is unavailable', undefined,
        error.actionId ? { actionId: error.actionId } : undefined,
      )
      return reply
    }
    if (error instanceof GmailDraftError) {
      const status = error.code === 'DRAFT_NOT_FOUND' ? 404
        : error.code === 'DRAFT_CHANGED' || error.code === 'DRAFT_NOT_SENDABLE'
          || error.code === 'DELIVERY_UNKNOWN' ? 409
          : error.code === 'PROVIDER_FAILED' ? 502 : 400
      sendApiError(reply, status, error.code, 'Gmail draft is unavailable')
      return reply
    }
    throw error
  }

  app.get('/api/mail/accounts', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved) return reply
    noStore(reply)
    return createApiResponse(await listConnectedMailAccounts(prisma, resolved.mailActor))
  })

  app.get('/api/mail/accounts/:source/:accountId/threads', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved) return reply
    const params = parseInput(AccountParamsSchema, request.params, reply, 'params')
    const query = parseInput(ConnectedMailThreadsQuerySchema, request.query, reply, 'query')
    if (!params || !query) return reply
    noStore(reply)
    try {
      return createApiResponse(await listConnectedMailThreads(prisma, resolved.mailActor, {
        ...params,
        ...query,
        pageSize: query.pageSize ?? 25,
        unreadOnly: query.unreadOnly === true ? true : query.unreadOnly === false ? false : undefined,
      }, serviceDeps))
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/mail/accounts/:source/:accountId/threads/:threadId', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved) return reply
    const params = parseInput(ConnectedMailConversationParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    noStore(reply)
    try {
      const conversation = await readConnectedMailConversation(
        prisma, resolved.mailActor, params, serviceDeps,
      )
      return createApiResponse(conversation)
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.get('/api/mail/accounts/:source/:accountId/send-actions/:actionId', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved) return reply
    const params = parseInput(SendActionParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    if (params.source !== 'mailbox') {
      sendApiError(reply, 409, 'CAPABILITY_UNSUPPORTED', 'Only SMTP mailboxes have send actions')
      return reply
    }
    try {
      const action = await readMailboxSendAction(
        prisma, resolved.mailActor, params.accountId, params.actionId,
      )
      noStore(reply)
      return createApiResponse(action)
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.post('/api/mail/accounts/:source/:accountId/drafts', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved || !requireMailMutationRequest(request, reply, deps)) return reply
    const params = parseInput(AccountParamsSchema, request.params, reply, 'params')
    const body = parseInput(ConnectedMailDraftCreateInputSchema, request.body, reply)
    if (!params || !body) return reply
    if (params.source !== 'gmail') {
      sendApiError(reply, 409, 'CAPABILITY_UNSUPPORTED', 'Only Gmail has provider drafts')
      return reply
    }
    try {
      const action = await composeDraftForUser(prisma, {
        connectionId: params.accountId,
        message: {
          bcc: body.bcc,
          body: body.body,
          cc: body.cc,
          inReplyTo: body.inReplyTo,
          subject: body.subject,
          to: body.to,
        },
        organizationId: resolved.mailActor.organizationId,
        idempotencyKey: body.idempotencyKey,
        providerThreadId: body.providerThreadId,
        userId: resolved.mailActor.userId,
      }, serviceDeps)
      noStore(reply)
      return createApiResponse({
        id: action.id, revision: action.revision, contentFingerprint: action.contentFingerprint,
      })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.patch('/api/mail/accounts/:source/:accountId/drafts/:draftId', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved || !requireMailMutationRequest(request, reply, deps)) return reply
    const params = parseInput(DraftParamsSchema, request.params, reply, 'params')
    const body = parseInput(ConnectedMailComposeInputSchema, request.body, reply)
    if (!params || !body) return reply
    if (params.source !== 'gmail') {
      sendApiError(reply, 409, 'CAPABILITY_UNSUPPORTED', 'Only Gmail has provider drafts')
      return reply
    }
    try {
      const action = await updateDraftForUser(prisma, {
        connectionId: params.accountId,
        draftActionId: params.draftId,
        message: {
          bcc: body.bcc,
          body: body.body,
          cc: body.cc,
          inReplyTo: body.inReplyTo,
          subject: body.subject,
          to: body.to,
        },
        organizationId: resolved.mailActor.organizationId,
        userId: resolved.mailActor.userId,
      }, serviceDeps)
      noStore(reply)
      return createApiResponse({
        id: action.id, revision: action.revision, contentFingerprint: action.contentFingerprint,
      })
    } catch (error) {
      return fail(reply, error)
    }
  })

  app.post('/api/mail/accounts/:source/:accountId/send', async (request, reply) => {
    const resolved = actor(request, reply)
    if (!resolved || !requireMailMutationRequest(request, reply, deps)) return reply
    const params = parseInput(AccountParamsSchema, request.params, reply, 'params')
    if (!params) return reply
    try {
      if (params.source === 'gmail') {
        const body = parseInput(ConnectedMailGmailDraftSendInputSchema, request.body, reply)
        if (!body) return reply
        const result = await sendDraftForUser(prisma, {
          connectionId: params.accountId,
          draftActionId: body.draftId,
          expectedFingerprint: body.expectedFingerprint,
          holdMs: UNDO_WINDOW_MS,
          organizationId: resolved.mailActor.organizationId,
          userId: resolved.mailActor.userId,
        }, serviceDeps)
        await emitAuditEvent(prisma, {
          action: result.status === 'held' ? 'gmail.draft.held' : 'gmail.draft.sent',
          actorContext: resolved.context, outcome: 'success',
          metadata: { source: params.source, status: result.status }, resourceId: result.action.id,
          resourceType: 'gmail_draft_action',
        })
        noStore(reply)
        return createApiResponse(result.status === 'held'
          ? { status: 'sending', sendAfter: result.sendAfter.toISOString() }
          : { status: 'sent', sentMessageId: result.sentMessageId })
      }
      const body = parseInput(ConnectedMailboxSendInputSchema, request.body, reply)
      if (!body) return reply
      const result = await sendConnectedMailboxMail(
        prisma, resolved.mailActor, params.accountId, body, serviceDeps,
      )
      await emitAuditEvent(prisma, {
        action: 'email.sent', actorContext: resolved.context, outcome: 'success',
        metadata: { source: params.source, status: 'sent' }, resourceId: params.accountId,
        resourceType: 'connected_mail_account',
      })
      noStore(reply)
      return createApiResponse(result)
    } catch (error) {
      if (params.source === 'mailbox' && error instanceof ConnectedMailError
        && error.code === 'DELIVERY_UNKNOWN' && error.deliveryUnknownTransitioned) {
        await emitAuditEvent(prisma, {
          action: 'email.send_failed', actorContext: resolved.context, outcome: 'error',
          metadata: { source: params.source, status: 'delivery_unknown' },
          resourceId: error.actionId ?? params.accountId,
          resourceType: error.actionId ? 'mailbox_send_action' : 'connected_mail_account',
        })
      }
      return fail(reply, error)
    }
  })
}
