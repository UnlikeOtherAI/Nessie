import type { FastifyInstance } from 'fastify'
import {
  CreateMailboxConnectionBodySchema,
  DiscoverMailboxConnectionBodySchema,
  MailboxDiscoveryResultSchema,
  ReconnectMailboxConnectionBodySchema,
  SetMailboxAgentAccessBodySchema,
  type MailboxDiscoveryExistingConnection,
  type MailboxProviderFamily,
} from '@nessie/schemas'
import {
  createMailboxDiscoveryService,
  MailboxDiscoveryAddressError,
} from '@nessie/agent-mail'
import { hasConnector } from '@nessie/comms-connect'
import {
  MailboxConnectionError,
  createMailboxConnection,
  deleteMailboxConnection,
  listMailboxConnectionsForUser,
  loadManageableMailboxConnection,
  presentMailboxConnection,
  reconnectMailboxConnection,
  setMailboxAgentAccess,
  verifyMailboxConnection,
  type MailboxActingMember,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { connectedMailboxAuditMetadata } from '../services/mailbox-audit.js'
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
  credential_rejected: 400,
  invalid_certificate: 400,
  invalid_address: 400,
  not_permitted: 403,
  server_unavailable: 503,
  team_not_found: 404,
  test_failed: 400,
}

export const registerMailboxConnectionRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, authSecret } = deps
  // Classification alone must never promise an OAuth button that this process
  // cannot complete. `hasConnector` proves the adapter was registered at
  // startup; the matching client pair proves its deployment config exists.
  const discovery = createMailboxDiscoveryService({
    capabilities: {
      appleAuthorization: false,
      google: hasConnector('google')
        && Boolean(
          process.env.NESSIE_COMMS_GOOGLE_CLIENT_ID
          && process.env.NESSIE_COMMS_GOOGLE_CLIENT_SECRET,
        ),
      jmap: false,
      microsoft: hasConnector('microsoft')
        && Boolean(process.env.NESSIE_COMMS_MICROSOFT_CLIENT_ID),
    },
  })

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

  const existingConnectionFor = async (input: {
    actor: MailboxActingMember
    address: string
    organizationId: string
    provider: MailboxProviderFamily
    scope?: 'user' | 'team'
    teamId?: string
  }): Promise<MailboxDiscoveryExistingConnection | undefined> => {
    // Model A personal mailboxes are visible only to the person who installed
    // them; administration role is intentionally irrelevant here.
    const storedAddress = input.address.toLowerCase()
    const own = await prisma.mailboxConnection.findFirst({
      select: { id: true },
      where: {
        address: storedAddress,
        organizationId: input.organizationId,
        ownerUserId: input.actor.userId,
      },
    })
    if (own) return { id: own.id, kind: 'mailbox_connection', scope: 'user' }

    // A shared connection is an existence hint only for the scope a manager is
    // explicitly setting up. This avoids both cross-team and cross-user leaks.
    if (
      input.scope === 'team' && input.teamId
      && (input.actor.role === 'admin' || input.actor.role === 'owner')
    ) {
      const shared = await prisma.mailboxConnection.findFirst({
        select: { id: true },
        where: {
          address: storedAddress,
          organizationId: input.organizationId,
          teamId: input.teamId,
        },
      })
      if (shared) return { id: shared.id, kind: 'mailbox_connection', scope: 'team' }
    }

    // Provider-native connections are personal by model. Restricting this
    // lookup to the caller and classified provider ensures it cannot become an
    // account-existence oracle for somebody else's connection.
    if (input.provider === 'google' || input.provider === 'microsoft') {
      const comms = await prisma.commsConnection.findFirst({
        select: { id: true },
        where: {
          externalUserId: storedAddress,
          organizationId: input.organizationId,
          ownerUserId: input.actor.userId,
          provider: input.provider,
        },
      })
      if (comms) return { id: comms.id, kind: 'comms_connection' }
    }
    return undefined
  }

  // ── POST /api/mailbox-connections/discover ───────────────────────────────
  // Address-first discovery is deliberately read-only: it has no credential,
  // creates no row, and leaves an undiscoverable mailbox as a normal manual
  // result rather than surfacing network probe failures to a person.
  app.post('/api/mailbox-connections/discover', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(DiscoverMailboxConnectionBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const result = await discovery(body.email)
      const existingConnection = await existingConnectionFor({
        actor: actingMember(actorContext),
        address: result.email,
        organizationId: actorContext.tenant.organizationId,
        provider: result.provider,
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.teamId ? { teamId: body.teamId } : {}),
      })
      return reply.send(createApiResponse(MailboxDiscoveryResultSchema.parse({
        ...result,
        ...(existingConnection ? { existingConnection } : {}),
      })))
    } catch (error) {
      if (error instanceof MailboxDiscoveryAddressError) {
        return sendApiError(reply, 400, 'INVALID_EMAIL_ADDRESS', error.message, 'email')
      }
      throw error
    }
  })

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
        // Resource id identifies this event; all mailbox and server details
        // remain outside the audit stream.
        metadata: connectedMailboxAuditMetadata(connection.scope),
        outcome: 'success',
        resourceId: connection.id,
        resourceType: 'mailbox_connection',
      })
      return reply.code(201).send(createApiResponse(connection))
    } catch (error) {
      return refuse(reply, error)
    }
  })

  // ── POST /api/mailbox-connections/:id/reconnect ──────────────────────────
  // Reconnect is deliberately not a second create route. It retains the
  // connection id, mailbox scope, and per-agent access rows, accepts a fresh
  // credential once, proves both mail legs before persisting it, then makes the
  // stopped capability active through one transaction.
  app.post('/api/mailbox-connections/:id/reconnect', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { id } = request.params as { id: string }
    const body = parseInput(ReconnectMailboxConnectionBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const existing = await loadManageableMailboxConnection(prisma, {
        actor: actingMember(actorContext),
        connectionId: id,
        organizationId: actorContext.tenant.organizationId,
      })
      const connection = await reconnectMailboxConnection(
        prisma,
        {
          actorUserId: actorContext.actor.actorId,
          connection: existing,
          imapHost: body.imapHost,
          imapPort: body.imapPort,
          imapSecurity: body.imapSecurity,
          password: body.password,
          smtpHost: body.smtpHost,
          smtpPort: body.smtpPort,
          smtpSecurity: body.smtpSecurity,
          username: body.username,
        },
        { encryptionSecret: authSecret },
      )
      await emitAuditEvent(prisma, {
        action: 'mailbox.connection.reconnected',
        actorContext,
        // Server endpoints and mailbox credentials stay out of the audit log.
        metadata: connectedMailboxAuditMetadata(connection.scope),
        outcome: 'success',
        resourceId: connection.id,
        resourceType: 'mailbox_connection',
      })
      return reply.send(createApiResponse(connection))
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
        metadata: connectedMailboxAuditMetadata(connection.ownerUserId ? 'user' : 'team'),
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
