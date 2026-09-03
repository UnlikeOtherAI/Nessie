import type { FastifyInstance } from 'fastify'
import {
  CreateMailboxConnectionBodySchema,
  SetMailboxAgentAccessBodySchema,
} from '@nessie/schemas'
import {
  MailboxConnectionError,
  createMailboxConnection,
  deleteMailboxConnection,
  listMailboxConnectionsForUser,
  loadManageableMailboxConnection,
  presentMailboxConnection,
  setMailboxAgentAccess,
  verifyMailboxConnection,
  type MailboxActingMember,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import type { RouteDeps } from './types.js'

/**
 * SMTP/IMAP mailbox connections — agent email Model A.
 *
 * Scope decides authorization throughout: a member connects and manages their
 * own mailbox, an owner or admin does the same for a team's shared one, and
 * nobody — whatever their role — reaches somebody else's personal mailbox. All
 * five handlers ask the same two service predicates rather than restating the
 * rule, so list, mutate and disconnect cannot drift apart.
 *
 * Nothing here can return the stored password: the presenter joins no
 * credential row, and the only place plaintext exists is the dial chokepoint in
 * the worker and this file's create handler, which seals it and forgets it.
 */

const STATUS_BY_REFUSAL: Record<string, number> = {
  address_taken: 409,
  agent_not_found: 404,
  connection_not_found: 404,
  invalid_address: 400,
  not_permitted: 403,
  team_not_found: 404,
  test_failed: 400,
}

export const registerMailboxConnectionRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, authSecret } = deps

  /**
   * The role the API already re-resolved for this request. `requireActorContext`
   * re-reads the live membership rather than trusting a session claim, so this
   * is current — a demoted admin loses the shared-mailbox routes immediately.
   */
  const actingMember = (actorContext: {
    actor: { actorId: string; roles?: string[] }
  }): MailboxActingMember => {
    const roles = actorContext.actor.roles ?? []
    return {
      role: roles.includes('owner') ? 'owner' : roles.includes('admin') ? 'admin' : 'member',
      userId: actorContext.actor.actorId,
    }
  }

  const refuse = (reply: Parameters<typeof sendApiError>[0], error: unknown): unknown => {
    if (error instanceof MailboxConnectionError) {
      return sendApiError(
        reply,
        STATUS_BY_REFUSAL[error.refusal] ?? 400,
        error.refusal.toUpperCase(),
        error.message,
      )
    }
    throw error
  }

  // ── GET /api/mailbox-connections ──────────────────────────────────────────
  app.get('/api/mailbox-connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const connections = await listMailboxConnectionsForUser(prisma, {
      actor: actingMember(actorContext),
      organizationId: actorContext.tenant.organizationId,
    })
    return reply.send(createApiResponse({ connections }))
  })

  // ── POST /api/mailbox-connections ─────────────────────────────────────────
  // Connecting tests both legs first, so a typo is a message on the form rather
  // than a mailbox that fails halfway through somebody's task later.
  app.post('/api/mailbox-connections', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(CreateMailboxConnectionBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const connection = await createMailboxConnection(
        prisma,
        {
          actor: actingMember(actorContext),
          address: body.address,
          imapHost: body.imapHost,
          imapPort: body.imapPort,
          imapSecurity: body.imapSecurity,
          label: body.label,
          organizationId: actorContext.tenant.organizationId,
          password: body.password,
          scope: body.scope,
          smtpHost: body.smtpHost,
          smtpPort: body.smtpPort,
          smtpSecurity: body.smtpSecurity,
          teamId: body.teamId ?? null,
          username: body.username,
        },
        { encryptionSecret: authSecret },
      )
      await emitAuditEvent(prisma, {
        action: 'mailbox.connection.created',
        actorContext,
        // The address and the scope; never the username or the password.
        metadata: { address: connection.address, scope: connection.scope },
        outcome: 'success',
        resourceId: connection.id,
        resourceType: 'mailbox_connection',
      })
      return reply.code(201).send(createApiResponse(connection))
    } catch (error) {
      return refuse(reply, error)
    }
  })

  // ── POST /api/mailbox-connections/:id/test ────────────────────────────────
  app.post('/api/mailbox-connections/:id/test', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    try {
      const connection = await loadManageableMailboxConnection(prisma, {
        actor: actingMember(actorContext),
        connectionId: id,
        organizationId: actorContext.tenant.organizationId,
      })
      const result = await verifyMailboxConnection(prisma, connection, {
        encryptionSecret: authSecret,
      })
      return reply.send(createApiResponse(result))
    } catch (error) {
      return refuse(reply, error)
    }
  })

  // ── DELETE /api/mailbox-connections/:id ───────────────────────────────────
  app.delete('/api/mailbox-connections/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    try {
      const connection = await loadManageableMailboxConnection(prisma, {
        actor: actingMember(actorContext),
        connectionId: id,
        organizationId: actorContext.tenant.organizationId,
      })
      await deleteMailboxConnection(prisma, connection.id)
      await emitAuditEvent(prisma, {
        action: 'mailbox.connection.deleted',
        actorContext,
        metadata: { address: connection.address },
        outcome: 'success',
        resourceId: connection.id,
        resourceType: 'mailbox_connection',
      })
      return reply.code(204).send()
    } catch (error) {
      return refuse(reply, error)
    }
  })

  // ── POST /api/mailbox-connections/:id/agent-access ────────────────────────
  // Which agent may use this mailbox. A per-pair decision, because a tool grant
  // is keyed by tool id and cannot name a mailbox.
  app.post('/api/mailbox-connections/:id/agent-access', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const body = parseInput(SetMailboxAgentAccessBodySchema, request.body, reply)
    if (!body) return reply

    try {
      const connection = await loadManageableMailboxConnection(prisma, {
        actor: actingMember(actorContext),
        connectionId: id,
        organizationId: actorContext.tenant.organizationId,
      })
      await setMailboxAgentAccess(prisma, {
        agentId: body.agentId,
        allowed: body.allowed,
        connectionId: connection.id,
        grantedByUserId: actorContext.actor.actorId,
        organizationId: actorContext.tenant.organizationId,
      })
      await emitAuditEvent(prisma, {
        action: body.allowed ? 'mailbox.access.granted' : 'mailbox.access.revoked',
        actorContext,
        metadata: { agentId: body.agentId },
        outcome: 'success',
        resourceId: connection.id,
        resourceType: 'mailbox_connection',
      })
      const updated = await prisma.mailboxConnection.findUniqueOrThrow({
        include: { agentAccess: { select: { agentId: true } } },
        where: { id: connection.id },
      })
      return reply.send(createApiResponse(presentMailboxConnection(updated)))
    } catch (error) {
      return refuse(reply, error)
    }
  })
}
