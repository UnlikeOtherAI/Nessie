import type { FastifyInstance } from 'fastify'
import {
  GmailDraftError,
  discardDraftForUser,
  grantSendAuthorization,
  listSendAuthorizations,
  readDraftForUser,
  revokeSendAuthorization,
  sendDraftForUser,
  undoHeldSend,
  updateDraftForUser,
  SEND_GRANT_DURATIONS,
} from '@nessie/workspace-admin'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import type { RouteDeps } from './types.js'

/**
 * The owner-gated draft surface behind the in-chat card.
 *
 * Every route resolves the draft by (id, organization, owner) and answers an
 * indistinguishable 404 otherwise: the card's message metadata carries only
 * identifiers, so this is the boundary that actually keeps a draft's recipients
 * and body away from everybody but the person whose mailbox it is.
 */

const UNDO_WINDOW_MS = Number(process.env.NESSIE_GMAIL_UNDO_WINDOW_MS ?? 15_000)

const DraftUpdateSchema = z.object({
  to: z.array(z.string()).min(1).max(50),
  cc: z.array(z.string()).max(50).optional(),
  bcc: z.array(z.string()).max(50).optional(),
  subject: z.string().max(500),
  body: z.string().max(100_000),
}).strict()

const SendSchema = z.object({
  /**
   * The fingerprint the card was showing. Sent back so a draft that changed
   * between render and click is refused instead of delivered.
   */
  expectedFingerprint: z.string().optional(),
  /** Skip the undo hold; used when the person explicitly says send now. */
  immediate: z.boolean().optional(),
}).strict()

const GrantSchema = z.object({
  connectionId: z.string().uuid(),
  agentId: z.string().uuid(),
  duration: z.enum(SEND_GRANT_DURATIONS),
}).strict()

const statusForDraftError = (code: GmailDraftError['code']): number => {
  if (code === 'DRAFT_NOT_FOUND') return 404
  if (code === 'DRAFT_CHANGED' || code === 'DRAFT_NOT_SENDABLE') return 409
  if (code === 'PROVIDER_FAILED') return 502
  return 400
}

export const registerGmailDraftRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, authSecret } = deps
  const draftDeps = { encryptionSecret: authSecret }

  const fail = (reply: Parameters<typeof sendApiError>[0], error: unknown) => {
    if (error instanceof GmailDraftError) {
      sendApiError(reply, statusForDraftError(error.code), error.code, error.message)
      return reply
    }
    throw error
  }

  // ── GET /api/gmail/drafts/:id ─────────────────────────────────────────────
  app.get('/api/gmail/drafts/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    try {
      const draft = await readDraftForUser(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          draftActionId: id,
        },
        draftDeps,
      )
      return createApiResponse({
        id: draft.action.id,
        state: draft.action.state,
        revision: draft.action.revision,
        contentFingerprint: draft.action.contentFingerprint,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
        attachments: draft.attachments,
      })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // ── PATCH /api/gmail/drafts/:id ───────────────────────────────────────────
  app.patch('/api/gmail/drafts/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const body = parseInput(DraftUpdateSchema, request.body, reply)
    if (!body) return reply
    try {
      const action = await updateDraftForUser(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          draftActionId: id,
          message: body,
        },
        draftDeps,
      )
      return createApiResponse({ id: action.id, revision: action.revision })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // ── POST /api/gmail/drafts/:id/send ───────────────────────────────────────
  // A person clicking Send on their own draft. Not an agent action, so no
  // approval machinery — but the same fingerprint check, because the draft can
  // change between the card rendering and the click.
  app.post('/api/gmail/drafts/:id/send', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const body = parseInput(SendSchema, request.body ?? {}, reply)
    if (!body) return reply
    try {
      const result = await sendDraftForUser(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          draftActionId: id,
          ...(body.expectedFingerprint
            ? { expectedFingerprint: body.expectedFingerprint }
            : {}),
          ...(body.immediate ? {} : { holdMs: UNDO_WINDOW_MS }),
        },
        draftDeps,
      )
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'gmail.draft.sent',
        resourceType: 'gmail_draft_action',
        resourceId: id,
        outcome: 'success',
        metadata: { status: result.status },
      })
      return createApiResponse(
        result.status === 'held'
          ? { status: 'sending', sendAfter: result.sendAfter.toISOString() }
          : { status: 'sent', sentMessageId: result.sentMessageId },
      )
    } catch (error) {
      return fail(reply, error)
    }
  })

  // ── POST /api/gmail/drafts/:id/undo ───────────────────────────────────────
  app.post('/api/gmail/drafts/:id/undo', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    try {
      const action = await undoHeldSend(prisma, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        draftActionId: id,
      })
      return createApiResponse({ id: action.id, state: action.state })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // ── DELETE /api/gmail/drafts/:id ──────────────────────────────────────────
  app.delete('/api/gmail/drafts/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    try {
      const action = await discardDraftForUser(
        prisma,
        {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          draftActionId: id,
        },
        draftDeps,
      )
      return createApiResponse({ id: action.id, state: action.state })
    } catch (error) {
      return fail(reply, error)
    }
  })

  // ── Standing send consent ─────────────────────────────────────────────────
  app.get('/api/gmail/send-grants', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    return createApiResponse({
      grants: await listSendAuthorizations(prisma, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      }),
    })
  })

  app.post('/api/gmail/send-grants', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(GrantSchema, request.body, reply)
    if (!body) return reply

    // The grant is the mailbox owner's to give, so the connection must be
    // theirs; anything else is an indistinguishable 404.
    const connection = await prisma.commsConnection.findFirst({
      where: {
        id: body.connectionId,
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
        provider: 'google',
      },
      select: { id: true },
    })
    if (!connection) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Connection not found')
      return reply
    }
    const grant = await grantSendAuthorization(prisma, {
      organizationId: actorContext.tenant.organizationId,
      connectionId: body.connectionId,
      agentId: body.agentId,
      grantedByUserId: actorContext.actor.actorId,
      duration: body.duration,
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'gmail.send_grant.created',
      resourceType: 'send_authorization_grant',
      resourceId: grant.id,
      outcome: 'success',
      metadata: { agentId: body.agentId, duration: body.duration },
    })
    return createApiResponse({
      id: grant.id,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    })
  })

  app.delete('/api/gmail/send-grants/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const revoked = await revokeSendAuthorization(prisma, {
      organizationId: actorContext.tenant.organizationId,
      grantId: id,
      userId: actorContext.actor.actorId,
    })
    if (!revoked) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Grant not found')
      return reply
    }
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'gmail.send_grant.revoked',
      resourceType: 'send_authorization_grant',
      resourceId: id,
      outcome: 'success',
    })
    return createApiResponse({ revoked: true })
  })
}
