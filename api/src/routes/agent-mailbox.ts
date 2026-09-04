import type { FastifyInstance } from 'fastify'
import { resolveAgentMailReadiness } from '@nessie/agent-mail'
import {
  CreateAgentMailboxBodySchema,
  UpdateAgentMailboxBodySchema,
} from '@nessie/schemas'
import {
  AgentMailboxError,
  createAgentMailbox,
  loadAgentMailbox,
  retireAgentMailbox,
  updateAgentMailbox,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { agentMailboxAuditMetadata } from '../services/mailbox-audit.js'
import {
  listMailboxConversations,
  listConversationMessages,
  presentMailbox,
  readableMailboxForAgent,
} from '../services/agent-mailbox.js'
import type { RouteDeps } from './types.js'

/**
 * Mailbox lifecycle and the mailbox surface's reads.
 *
 * Claiming an address mints an externally visible identity for the whole
 * organisation, so create / update / delete are owner-gated. The *reads* are
 * not: whoever can see the agent can read its correspondence, decided by the
 * shared agent-visibility predicate through `readableMailboxForAgent` — never
 * by ambient session scope.
 */
export const registerAgentMailboxRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  const readiness = () => resolveAgentMailReadiness(deps.config.email)

  // ── GET /api/agents/:agentId/mailbox ──────────────────────────────────────
  app.get('/api/agents/:agentId/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { agentId } = request.params as { agentId: string }

    const readable = await readableMailboxForAgent(prisma, {
      agentId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!readable) {
      return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')
    }
    return reply.send(createApiResponse(presentMailbox(readable)))
  })

  // ── GET /api/agent-email/config ───────────────────────────────────────────
  // Whether this deployment can host mail at all, and — for an owner — exactly
  // which variables are missing when it cannot. A member is told only that the
  // feature is unavailable; operator configuration is not their business.
  app.get('/api/agent-email/config', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const state = readiness()
    const isOwner = actorContext.actor.roles?.includes('owner') ?? false
    if (state.ready) {
      // A member learns only that hosted email exists — they have no write path
      // that needs the operator's configuration, and only an owner can claim an
      // address (which is where the domain is actually needed).
      return reply.send(
        createApiResponse({
          available: true,
          ...(isOwner
            ? { customDomains: state.config.customDomains, domain: state.config.domain }
            : {}),
        }),
      )
    }
    return reply.send(
      createApiResponse({
        available: false,
        ...(isOwner ? { missing: state.missing, reason: state.reason } : {}),
      }),
    )
  })

  // ── POST /api/agents/:agentId/mailbox ─────────────────────────────────────
  app.post('/api/agents/:agentId/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const state = readiness()
    if (!state.ready) {
      return sendApiError(
        reply,
        409,
        'AGENT_MAIL_UNCONFIGURED',
        state.reason,
        undefined,
        { missing: state.missing },
      )
    }

    const { agentId } = request.params as { agentId: string }
    const body = parseInput(CreateAgentMailboxBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const mailbox = await createAgentMailbox(prisma, {
        agentId,
        createdByUserId: actorContext.actor.actorId,
        defaultDomain: state.config.domain,
        displayName: body.displayName ?? null,
        domainId: body.domainId ?? null,
        localPart: body.localPart,
        organizationId: actorContext.tenant.organizationId,
      })
      await emitAuditEvent(prisma, {
        action: 'email.mailbox.created',
        actorContext,
        metadata: agentMailboxAuditMetadata.created(agentId),
        outcome: 'success',
        resourceId: mailbox.id,
        resourceType: 'agent_mailbox',
      })
      return reply.code(201).send(createApiResponse(presentMailbox(mailbox)))
    } catch (error) {
      if (error instanceof AgentMailboxError) {
        const status = error.refusal === 'agent_not_found' ? 404 : 409
        return sendApiError(
          reply,
          status,
          error.refusal.toUpperCase(),
          error.message,
          undefined,
          error.suggestions.length > 0 ? { suggestions: error.suggestions } : undefined,
        )
      }
      throw error
    }
  })

  // ── PATCH /api/agents/:agentId/mailbox ────────────────────────────────────
  app.patch('/api/agents/:agentId/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { agentId } = request.params as { agentId: string }
    const body = parseInput(UpdateAgentMailboxBodySchema, request.body, reply)
    if (!body) return reply

    const existing = await loadAgentMailbox(prisma, {
      agentId,
      organizationId: actorContext.tenant.organizationId,
    })
    if (!existing) return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')

    const updated = await updateAgentMailbox(prisma, {
      displayName: body.displayName,
      mailboxId: existing.id,
      organizationId: actorContext.tenant.organizationId,
      sendPolicy: body.sendPolicy,
    })
    if (!updated) return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')

    await emitAuditEvent(prisma, {
      action: 'email.mailbox.updated',
      actorContext,
      metadata: agentMailboxAuditMetadata.updated(updated.sendPolicy),
      outcome: 'success',
      resourceId: updated.id,
      resourceType: 'agent_mailbox',
    })
    return reply.send(createApiResponse(presentMailbox(updated)))
  })

  // ── DELETE /api/agents/:agentId/mailbox ───────────────────────────────────
  app.delete('/api/agents/:agentId/mailbox', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { agentId } = request.params as { agentId: string }
    const existing = await loadAgentMailbox(prisma, {
      agentId,
      organizationId: actorContext.tenant.organizationId,
    })
    if (!existing) return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')

    const retired = await retireAgentMailbox(prisma, {
      mailboxId: existing.id,
      organizationId: actorContext.tenant.organizationId,
    })
    if (!retired) return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')

    await emitAuditEvent(prisma, {
      action: 'email.mailbox.deleted',
      actorContext,
      // The address stays claimed forever: a recycled local part must never
      // inherit an old correspondent's trust. The structural fact is enough
      // for audit; the address itself is never emitted.
      metadata: agentMailboxAuditMetadata.retired(),
      outcome: 'success',
      resourceId: existing.id,
      resourceType: 'agent_mailbox',
    })
    return reply.code(204).send()
  })

  // ── GET /api/agents/:agentId/mailbox/conversations ────────────────────────
  app.get('/api/agents/:agentId/mailbox/conversations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { agentId } = request.params as { agentId: string }
    const query = request.query as { limit?: string; cursor?: string; filter?: string }

    const readable = await readableMailboxForAgent(prisma, {
      agentId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!readable) return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')

    const page = await listMailboxConversations(prisma, {
      cursor: query.cursor,
      filter: query.filter === 'inbox' || query.filter === 'sent' ? query.filter : 'all',
      limit: Math.min(Number(query.limit) || 25, 100),
      mailboxId: readable.id,
    })
    return reply.send(createApiResponse(page.items, page.pagination))
  })

  // ── GET /api/agents/:agentId/mailbox/conversations/:conversationId ────────
  app.get(
    '/api/agents/:agentId/mailbox/conversations/:conversationId/messages',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply
      const { agentId, conversationId } = request.params as {
        agentId: string
        conversationId: string
      }

      const readable = await readableMailboxForAgent(prisma, {
        agentId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      })
      if (!readable) return sendApiError(reply, 404, 'NOT_FOUND', 'Mailbox not found.')

      const messages = await listConversationMessages(prisma, {
        conversationId,
        mailboxId: readable.id,
      })
      if (!messages) {
        // Indistinguishable from an unreadable mailbox: a conversation id is a
        // global UUID, and the mailbox gate alone would leak another agent's.
        return sendApiError(reply, 404, 'NOT_FOUND', 'Conversation not found.')
      }
      return reply.send(createApiResponse(messages))
    },
  )
}
