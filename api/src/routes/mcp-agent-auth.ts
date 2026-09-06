import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AgentAccessScope } from '@prisma/client'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { resolveAdminOrigin } from './mcp/oauth.js'
import {
  decideDeviceAuthorization,
  loadPendingAuthorization,
  normalizeUserCode,
  redeemDeviceAuthorization,
  startDeviceAuthorization,
  DEVICE_POLL_INTERVAL_SECONDS,
} from '../services/mcp-agent/device-authorization.js'
import { revokeAgentAccessCredential } from '../services/mcp-agent/agent-credential.js'
import { loadLedgerIdentitySettings } from '@nessie/runtime'
import type { RouteDeps } from './types.js'

/**
 * Pairing an agent with a person's account (RFC 8628), and managing what that
 * produced.
 *
 * The two device-grant endpoints are `public`: they are reached by an agent
 * that has no credential yet, which is the entire point of a pairing flow. They
 * are not unauthenticated in effect — neither one grants anything until a
 * signed-in human approves the request through the approval routes below, which
 * are ordinary authenticated routes.
 */

// Read once at startup, exactly as the runtime signer is: whether this
// deployment signs Ledger calls is never a per-request decision.
const ledgerSigningConfigured = loadLedgerIdentitySettings() !== null

const ScopeSchema = z.nativeEnum(AgentAccessScope)

const StartDeviceBodySchema = z.object({
  /** Whatever the client calls itself. Untrusted display text. */
  clientName: z.string().min(1).max(120),
  scopes: z.array(ScopeSchema).min(1),
})

const DeviceTokenBodySchema = z.object({
  deviceCode: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
})

const ApproveBodySchema = z.object({
  approve: z.boolean(),
  scopes: z.array(ScopeSchema).default([]),
  userCode: z.string().min(1),
})

export const registerMcpAgentAuthRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { config, prisma, requireActorContext } = deps

  app.post(
    '/mcp/auth/device',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(StartDeviceBodySchema, request.body, reply)
      if (!body) return reply

      const started = await startDeviceAuthorization(prisma, {
        clientName: body.clientName,
        scopes: body.scopes,
      })

      // The ADMIN origin, not this one. The person approving opens a page in
      // the admin app; sending them to the API origin hands them a URL that
      // serves JSON, and the whole pairing dead-ends there.
      const adminOrigin = resolveAdminOrigin(config)
      if (!adminOrigin) {
        sendApiError(
          reply,
          500,
          'ADMIN_ORIGIN_UNCONFIGURED',
          'This deployment has no admin origin configured, so it cannot tell an agent where to send its human. '
          + 'Set NESSIE_ADMIN_PUBLIC_URL.',
        )
        return reply
      }
      const verificationUri = `${adminOrigin}/settings/agent-access`

      // Snake_case because this half of the exchange is RFC 8628's, and a
      // client implementing the standard reads these names.
      return reply.code(201).send({
        device_code: started.deviceCode,
        expires_in: started.expiresInSeconds,
        interval: started.intervalSeconds,
        user_code: started.userCode,
        verification_uri: verificationUri,
        verification_uri_complete:
          `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
      })
    },
  )

  app.post(
    '/mcp/auth/token',
    { config: { public: true } },
    async (request, reply) => {
      const body = parseInput(DeviceTokenBodySchema, request.body, reply)
      if (!body) return reply

      const result = await redeemDeviceAuthorization(prisma, {
        deviceCode: body.deviceCode,
        ...(body.label === undefined ? {} : { label: body.label }),
      })

      if (result.kind === 'issued') {
        return reply.code(201).send({
          access_token: result.credential.token,
          expires_at: result.credential.credential.expiresAt.toISOString(),
          scope: result.credential.credential.scopes.join(' '),
          token_type: 'Bearer',
        })
      }

      // RFC 8628 §3.5 keeps polling errors at 400 with a machine-readable
      // `error`, because a client implementing the standard already knows what
      // each one means: keep waiting, back off, or stop.
      const status = result.kind === 'slow_down' || result.kind === 'authorization_pending'
        ? 400
        : 400
      return reply.code(status).send({
        error: result.kind,
        ...(result.kind === 'slow_down' ? { interval: DEVICE_POLL_INTERVAL_SECONDS * 2 } : {}),
      })
    },
  )

  // --- The human's side. Ordinary authenticated routes. ----------------------

  app.get('/api/mcp/agent-access/pending', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { code } = request.query as { code?: string }
    if (!code) {
      sendApiError(reply, 400, 'USER_CODE_REQUIRED', 'A pairing code is required')
      return reply
    }

    const pending = await loadPendingAuthorization(prisma, code)
    if (!pending) {
      // One honest answer for unknown, already-decided and expired alike: which
      // of those it was is not something an unauthenticated guesser should be
      // able to learn by trying codes.
      sendApiError(
        reply,
        404,
        'PAIRING_CODE_INVALID',
        'That pairing code is not valid. Ask the agent for a new one.',
      )
      return reply
    }

    return createApiResponse({
      clientName: pending.clientName,
      requestedScopes: pending.requestedScopes,
    })
  })

  app.post('/api/mcp/agent-access/decide', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const body = parseInput(ApproveBodySchema, request.body, reply)
    if (!body) return reply

    const pending = await loadPendingAuthorization(prisma, body.userCode)
    if (!pending) {
      sendApiError(
        reply,
        404,
        'PAIRING_CODE_INVALID',
        'That pairing code is not valid. Ask the agent for a new one.',
      )
      return reply
    }

    // A team is required, not optional.
    //
    // Attribution here is scoped by project AND team — the knowledge indexer
    // refuses a version whose origin carries no team, so a credential minted
    // without one can read documents but fails the moment it writes any. The
    // same requirement the scheduled-trigger route already states, and for the
    // same reason: refuse now, while there is somebody to tell, rather than at
    // every use.
    const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
    const projectId = actorContext.tenant.projectId
    if (body.approve && (!teamId || !projectId)) {
      sendApiError(
        reply,
        400,
        'AGENT_ACCESS_TEAM_REQUIRED',
        'Pairing an agent needs an active project and team. Pick one, then approve again.',
      )
      return reply
    }

    // The credential will act as this person, in this tenant. Taking the scope
    // from their live session rather than anything the agent proposed is what
    // stops an agent naming a workspace its human cannot reach.
    // A signing deployment cannot let an agent write documents without an
    // identity to sign the indexing that follows: the tool would report success
    // and the embedding would fail later, in the background, where nobody is
    // looking. Refuse now, while there is somebody to tell — the same refusal
    // the scheduled-trigger create route makes, for the same reason.
    const writesDocuments =
      body.approve && (body.scopes ?? []).some((scope) => scope.startsWith('documents_'))
    if (
      writesDocuments
      && ledgerSigningConfigured
      && !actorContext.actionContext.uoaIdentity
    ) {
      sendApiError(
        reply,
        400,
        'AGENT_ACCESS_UOA_IDENTITY_REQUIRED',
        'Granting document access needs an UnlikeOtherAI SSO session. Sign in through SSO and approve again.',
      )
      return reply
    }

    const outcome = await decideDeviceAuthorization(prisma, {
      approve: body.approve,
      approvedScopes: body.scopes ?? [],
      organizationId: actorContext.tenant.organizationId,
      projectId: projectId ?? '',
      requestId: pending.id,
      teamId: teamId ?? null,
      ...(actorContext.actionContext.uoaIdentity
        ? { uoaIdentity: actorContext.actionContext.uoaIdentity }
        : {}),
      userId: actorContext.actor.actorId,
    })

    if (outcome.kind === 'not_pending') {
      sendApiError(
        reply,
        409,
        'PAIRING_ALREADY_DECIDED',
        'That pairing request was already decided or has expired.',
      )
      return reply
    }

    return createApiResponse({ approved: body.approve })
  })

  app.get('/api/mcp/agent-access/credentials', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const credentials = await prisma.agentAccessCredential.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        expiresAt: true,
        id: true,
        label: true,
        lastUsedAt: true,
        revokedAt: true,
        scopes: true,
        tokenPrefix: true,
      },
      // Their own. An owner-wide view is a separate, deliberate surface — a
      // credential list is a list of live footholds, not general reading.
      where: {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      },
    })

    return createApiResponse({
      credentials: credentials.map((credential) => ({
        ...credential,
        createdAt: credential.createdAt.toISOString(),
        expiresAt: credential.expiresAt.toISOString(),
        lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
        revokedAt: credential.revokedAt?.toISOString() ?? null,
      })),
    })
  })

  app.post('/api/mcp/agent-access/credentials/:credentialId/revoke', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { credentialId } = request.params as { credentialId: string }
    const owned = await prisma.agentAccessCredential.findFirst({
      select: { id: true },
      where: {
        id: credentialId,
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      },
    })
    if (!owned) {
      sendApiError(reply, 404, 'AGENT_CREDENTIAL_NOT_FOUND', 'Agent credential not found')
      return reply
    }

    const revoked = await revokeAgentAccessCredential(prisma, {
      credentialId,
      organizationId: actorContext.tenant.organizationId,
    })
    return createApiResponse({ revoked })
  })
}

export { normalizeUserCode }
