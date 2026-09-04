import type { FastifyInstance, FastifyRequest } from 'fastify'
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
} from '@nessie/team-admin'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { isOriginAllowed } from '../lib/server-origin-policy.js'
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
  /**
   * `always` sends whenever the owner asks. `judged` has the assistant weigh
   * each action against `boundary` and ask when it is unsure — so a boundary
   * is required with it, and a judged grant without one would have nothing to
   * judge against.
   */
  mode: z.enum(['always', 'judged']).optional(),
  boundary: z.string().max(4000).optional(),
}).strict().refine(
  (value) => value.mode !== 'judged' || (value.boundary ?? '').trim().length > 0,
  { message: 'Deciding for you needs a note saying what you are happy with.' },
)

const FromApprovalSchema = z.object({
  approvalId: z.string().uuid(),
  duration: z.enum(SEND_GRANT_DURATIONS),
  mode: z.enum(['always', 'judged']).optional(),
  boundary: z.string().max(4000).optional(),
}).strict().refine(
  (value) => value.mode !== 'judged' || (value.boundary ?? '').trim().length > 0,
  { message: 'Deciding for you needs a note saying what you are happy with.' },
)

const statusForDraftError = (code: GmailDraftError['code']): number => {
  if (code === 'DRAFT_NOT_FOUND') return 404
  if (code === 'DRAFT_CHANGED' || code === 'DRAFT_NOT_SENDABLE') return 409
  if (code === 'PROVIDER_FAILED') return 502
  return 400
}

const requireDraftUndoRequest = (
  request: FastifyRequest,
  reply: Parameters<typeof sendApiError>[0],
  deps: RouteDeps,
): boolean => {
  const origin = deps.parseHeaderValue(request.headers.origin)
  if (!origin || !isOriginAllowed({
    allowedOrigins: deps.allowedCorsOrigins, mode: deps.config.mode, origin,
  })) {
    sendApiError(reply, 403, 'ORIGIN_FORBIDDEN', 'A permitted browser origin is required')
    return false
  }
  if (!deps.isJsonContentType(request)) {
    sendApiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json')
    return false
  }
  return true
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
      reply.header('Cache-Control', 'private, no-store')
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
    if (!actorContext || !requireDraftUndoRequest(request, reply, deps)) return reply
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
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.boundary !== undefined ? { boundary: body.boundary } : {}),
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'gmail.send_grant.created',
      resourceType: 'send_authorization_grant',
      resourceId: grant.id,
      outcome: 'success',
      // The boundary itself is the owner's private words and never enters an
      // audit row; the mode is the decision worth recording.
      metadata: {
        agentId: body.agentId,
        duration: body.duration,
        mode: body.mode ?? 'always',
      },
    })
    return createApiResponse({
      id: grant.id,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    })
  })

  // ── POST /api/gmail/send-grants/from-approval ─────────────────────────────
  // "Don't ask me again", from the approval card.
  //
  // The client knows the approval, not the mailbox — resolving the connection
  // here keeps the caller from having to name one, and keeps a caller from
  // naming somebody else's. The grant is only ever created for the person the
  // approval is pinned to.
  app.post('/api/gmail/send-grants/from-approval', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(FromApprovalSchema, request.body, reply)
    if (!body) return reply

    const approval = await prisma.approvalRequest.findFirst({
      where: {
        id: body.approvalId,
        organizationId: actorContext.tenant.organizationId,
        // Only the person the gate is pinned to may turn it off.
        requiredApproverUserId: actorContext.actor.actorId,
      },
      select: { agentId: true },
    })
    if (!approval) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found')
      return reply
    }

    // One active Google account is unambiguous; two are not, and a grant is per
    // mailbox, so guessing would spend consent on the wrong one.
    const connections = await prisma.commsConnection.findMany({
      where: {
        organizationId: actorContext.tenant.organizationId,
        ownerUserId: actorContext.actor.actorId,
        provider: 'google',
        status: 'active',
      },
      select: { id: true },
      take: 2,
    })
    const connectionId = connections.length === 1 ? connections[0]?.id : undefined
    if (!connectionId) {
      sendApiError(
        reply,
        409,
        'AMBIGUOUS_ACCOUNT',
        connections.length === 0
          ? 'No connected Google account'
          : 'You have more than one Google account connected — choose one in '
            + 'Connected accounts.',
      )
      return reply
    }

    const grant = await grantSendAuthorization(prisma, {
      organizationId: actorContext.tenant.organizationId,
      connectionId,
      agentId: approval.agentId,
      grantedByUserId: actorContext.actor.actorId,
      duration: body.duration,
      mode: body.mode ?? 'always',
      ...(body.boundary !== undefined ? { boundary: body.boundary } : {}),
    })
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'gmail.send_grant.created',
      resourceType: 'send_authorization_grant',
      resourceId: grant.id,
      outcome: 'success',
      metadata: {
        agentId: approval.agentId,
        duration: body.duration,
        mode: body.mode ?? 'always',
        fromApproval: body.approvalId,
      },
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
