import {
  addCustomApp,
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  connectApp,
  createMcpSecretResolver,
  createPgOAuthStateStore,
  createPgSecretStore,
  disconnectAppConnection,
  getStoreApp,
  reconnectAppConnection,
  refreshAppConnectionCapabilities,
  type AppConnectContext,
  type AppConnectErrorCode,
  type AppConnectOutcome,
  type ManagerFactory,
  type McpUrlSafetyOptions,
  type OAuthStateStore,
  type SecretResolver,
  type SecretStore,
} from '@nessie/mcp-manage'
import {
  isHttpUrl,
  McpServerScopeTypeSchema,
  type AuthorizedActionContext,
  type McpServerScopeType,
} from '@nessie/schemas'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { PublicOriginConfigError } from '../lib/public-origin.js'
import { emitAuditEvent } from '../services/audit.js'

import { guardAuthRequest, RATE_LIMIT_BUCKETS } from './auth-rate-limit.js'
import { buildOAuthCallbackUrl } from './mcp/oauth.js'
import { sendMcpError } from './mcp/shared.js'
import type { RouteDeps } from './types.js'

/**
 * The App Store's Connect surface
 * (`docs/plans/2026-08-29-apps-catalogue/ux-design-detail-and-connect.md` §2,
 * §3, §5).
 *
 * Every route here is a thin shell around `@nessie/mcp-manage`'s connect
 * orchestration, which is itself an arrangement of the connector layer that
 * already existed — one instance creator, one OAuth client, one token vault.
 * These handlers validate input, pick a status code, and write the audit
 * entry; nothing else.
 *
 * Member-level (`requireActorContext`), like the rest of `/api/apps`: whether a
 * person may connect *this app at this scope* is a scope question the shared
 * service answers, not a role gate on the door. And as everywhere on this
 * surface, no response carries a credential ref, an auth or transport config,
 * or an endpoint URL — the connect outcome is a decision plus an id.
 */

const ConnectBodySchema = z
  .object({
    scopeType: McpServerScopeTypeSchema,
    // Optional because the two scopes people actually pick are implied by who
    // is asking; anything else names its own target.
    scopeId: z.string().uuid().optional(),
  })
  .strict()

const CustomAppBodySchema = z
  .object({
    url: z.string().trim().min(3).max(2000),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

const SlugParamsSchema = z.object({ slug: z.string().min(1).max(200) })
const ConnectionParamsSchema = z.object({ id: z.string().uuid() })

const APP_CONNECT_STATUS: Record<AppConnectErrorCode, number> = {
  [APP_CONNECT_ERROR_CODES.APP_NOT_FOUND]: 404,
  [APP_CONNECT_ERROR_CODES.CONNECTION_NOT_FOUND]: 404,
  [APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN]: 403,
  [APP_CONNECT_ERROR_CODES.SERVER_INVALID]: 400,
  // The app's server, or its authorization server, failed us — not the caller.
  [APP_CONNECT_ERROR_CODES.SERVER_UNREACHABLE]: 502,
  [APP_CONNECT_ERROR_CODES.OAUTH_DISCOVERY_FAILED]: 502,
  [APP_CONNECT_ERROR_CODES.CLIENT_APPROVAL_REQUIRED]: 424,
  [APP_CONNECT_ERROR_CODES.CLIENT_REGISTRATION_FAILED]: 502,
  [APP_CONNECT_ERROR_CODES.CONNECTION_FAILED]: 502,
}

/**
 * Store vocabulary first, connector vocabulary second. `AppConnectError` codes
 * are the ones the design document's copy table is keyed by; anything the
 * connector layer raises for itself (a locked catalogue entry, a scope
 * collision, an integration-managed connector) keeps the reply
 * `registerMcpRoutes` would have sent, so the two surfaces answer alike.
 */
const sendConnectError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof AppConnectError) {
    sendApiError(reply, APP_CONNECT_STATUS[error.code], error.code, error.message)
    return true
  }
  return sendMcpError(reply, error)
}

/**
 * The scope this connection lands in. "Just me" and "everyone in the
 * organisation" are the caller's own identity and tenant, so asking a browser
 * to send back ids it was given is ceremony; a narrower scope names itself.
 */
const resolveScopeId = (
  actorContext: AuthorizedActionContext,
  scopeType: McpServerScopeType,
  provided: string | undefined,
): string | null => {
  if (provided) return provided
  if (scopeType === 'user') return actorContext.actor.actorId
  if (scopeType === 'organization') return actorContext.tenant.organizationId
  return null
}

export type AppsConnectDeps = RouteDeps & {
  /**
   * Test seams. Production builds each from the deployment auth secret exactly
   * as `registerMcpRoutes` does — the same factory over the same key, so a ref
   * minted by an App Store connect resolves through the worker unchanged.
   * There is one vault; this is the wiring, not a copy.
   */
  oauthSecretStore?: SecretStore
  secretResolver?: SecretResolver
  oauthStateStore?: OAuthStateStore
  oauthResolveHost?: McpUrlSafetyOptions['resolveHost']
  managerFactory?: ManagerFactory
}

export const registerAppsConnectRoutes = (
  app: FastifyInstance,
  deps: AppsConnectDeps,
): void => {
  const { prisma, requireActorContext, config, rateLimiter } = deps
  const encryptionSecret = deps.authSecret ?? ''
  const oauthSecretStore = deps.oauthSecretStore ?? createPgSecretStore(prisma, encryptionSecret)
  const secretResolver = deps.secretResolver ?? createMcpSecretResolver(prisma, encryptionSecret)
  const stateStore = deps.oauthStateStore ?? createPgOAuthStateStore(prisma)

  /**
   * Connect dials third-party servers and mints OAuth state, so it carries the
   * same brute-force guard as `POST /api/mcp/instances/:id/oauth/start` — the
   * same bucket, because it is the same scarce thing being sprayed.
   */
  const guard = (request: FastifyRequest, reply: FastifyReply, actorContext: AuthorizedActionContext) =>
    guardAuthRequest(
      rateLimiter,
      { bucket: RATE_LIMIT_BUCKETS.mcpOauthIp, rule: config.api.rateLimit.mcpOauthIp },
      request,
      reply,
      { auditContext: actorContext },
    )

  /**
   * The callback origin is resolved server-side from configuration, never from
   * the request, and a deployment that cannot name its own public origin must
   * fail *before* a state token is minted or a client is registered against a
   * steered origin.
   */
  const buildContext = (
    request: FastifyRequest,
    reply: FastifyReply,
    actorContext: AuthorizedActionContext,
  ): AppConnectContext | null => {
    try {
      return {
        prisma,
        actorContext,
        oauth: {
          callbackUrl: buildOAuthCallbackUrl(request, config),
          stateStore,
          secretStore: oauthSecretStore,
          resolveHost: deps.oauthResolveHost,
        },
        secretResolver,
        managerFactory: deps.managerFactory,
      }
    } catch (error) {
      if (error instanceof PublicOriginConfigError) {
        sendApiError(
          reply,
          500,
          'PUBLIC_ORIGIN_NOT_CONFIGURED',
          'The server cannot determine its public origin; set NESSIE_API_PUBLIC_URL '
            + 'to the public origin of this API (required outside local mode)',
        )
        return null
      }
      throw error
    }
  }

  /**
   * One connect attempt, as the audit trail sees it. `status` records how far
   * it got, because "a connection now exists, awaiting a sign-in" is a real
   * event and not a failed one. Nothing here can carry a token: the metadata is
   * ids, a scope, and the outcome word — never the authorization URL, which
   * carries the state parameter.
   */
  const auditConnect = async (
    actorContext: AuthorizedActionContext,
    detail: {
      appId: string
      connectionId?: string
      scopeType: McpServerScopeType
      scopeId: string
      status?: AppConnectOutcome['status']
      errorCode?: string
    },
  ): Promise<void> => {
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'app.connected',
      resourceType: 'mcp_server_instance',
      resourceId: detail.connectionId ?? detail.appId,
      outcome: detail.errorCode ? 'error' : 'success',
      reason: detail.errorCode,
      metadata: {
        appId: detail.appId,
        scopeType: detail.scopeType,
        scopeId: detail.scopeId,
        ...(detail.status ? { status: detail.status } : {}),
      },
    })
  }

  app.post('/api/apps/:slug/connect', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await guard(request, reply, actorContext))) return reply

    const params = parseInput(SlugParamsSchema, request.params, reply, 'slug')
    if (!params) return reply
    const body = parseInput(ConnectBodySchema, request.body ?? {}, reply)
    if (!body) return reply

    const scopeId = resolveScopeId(actorContext, body.scopeType, body.scopeId)
    if (!scopeId) {
      sendApiError(reply, 400, 'VALIDATION_ERROR', 'scopeId is required for this scope', 'scopeId')
      return reply
    }
    const ctx = buildContext(request, reply, actorContext)
    if (!ctx) return reply

    try {
      const { app: record, outcome } = await connectApp(ctx, {
        identifier: params.slug,
        scopeType: body.scopeType,
        scopeId,
      })
      await auditConnect(actorContext, {
        appId: record.id,
        connectionId: outcome.connectionId,
        scopeType: body.scopeType,
        scopeId,
        status: outcome.status,
      })
      return createApiResponse(outcome)
    } catch (error) {
      if (error instanceof AppConnectError) {
        await auditConnect(actorContext, {
          appId: params.slug,
          scopeType: body.scopeType,
          scopeId,
          errorCode: error.code,
        })
      }
      if (sendConnectError(reply, error)) return reply
      throw error
    }
  })

  /**
   * "Add a custom app": one pasted address becomes a catalogue row and a
   * connection. Defaults to the caller's own scope — self-service is what
   * members can always do, and a wider scope is a deliberate choice the shared
   * service still checks.
   */
  app.post('/api/apps/custom', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await guard(request, reply, actorContext))) return reply

    const body = parseInput(CustomAppBodySchema, request.body, reply)
    if (!body) return reply

    // Discovery would refuse a non-http(s) address downstream; refusing it here
    // makes the constraint a stated contract rather than a lucky side effect.
    if (/^[a-z][a-z0-9+.-]*:/i.test(body.url) && !isHttpUrl(body.url)) {
      sendApiError(
        reply,
        400,
        APP_CONNECT_ERROR_CODES.SERVER_INVALID,
        'An app address must be an http(s) URL',
        'url',
      )
      return reply
    }

    const ctx = buildContext(request, reply, actorContext)
    if (!ctx) return reply

    try {
      const { app: entry } = await addCustomApp(ctx, {
        url: body.url,
        name: body.name,
      })
      // Read back through the store presenter rather than shaping a catalogue
      // row by hand: it is the one thing that decides what `/api/apps` may say
      // about an app, and the client needs the slug to reach `/apps/:slug`.
      const record = await getStoreApp(prisma, actorContext, entry.id)
      return reply.code(201).send(createApiResponse({ appId: entry.id, app: record }))
    } catch (error) {
      if (sendConnectError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/app-connections/:id/reconnect', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!(await guard(request, reply, actorContext))) return reply

    const params = parseInput(ConnectionParamsSchema, request.params, reply, 'id')
    if (!params) return reply
    const ctx = buildContext(request, reply, actorContext)
    if (!ctx) return reply

    try {
      const outcome = await reconnectAppConnection(ctx, params.id)
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'app.connected',
        resourceType: 'mcp_server_instance',
        resourceId: params.id,
        outcome: 'success',
        metadata: { status: outcome.status, reconnect: true },
      })
      return createApiResponse(outcome)
    } catch (error) {
      if (sendConnectError(reply, error)) return reply
      throw error
    }
  })

  app.post('/api/app-connections/:id/refresh-capabilities', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const params = parseInput(ConnectionParamsSchema, request.params, reply, 'id')
    if (!params) return reply
    const ctx = buildContext(request, reply, actorContext)
    if (!ctx) return reply

    try {
      const result = await refreshAppConnectionCapabilities(ctx, params.id)
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'app.capabilities_refreshed',
        resourceType: 'mcp_server_instance',
        resourceId: params.id,
        outcome: result.status === 'error' ? 'error' : 'success',
        metadata: { status: result.status, toolCount: result.toolCount },
      })
      return createApiResponse(result)
    } catch (error) {
      if (sendConnectError(reply, error)) return reply
      throw error
    }
  })

  app.delete('/api/app-connections/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const params = parseInput(ConnectionParamsSchema, request.params, reply, 'id')
    if (!params) return reply
    const ctx = buildContext(request, reply, actorContext)
    if (!ctx) return reply

    try {
      const removed = await disconnectAppConnection(ctx, params.id)
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'app.disconnected',
        resourceType: 'mcp_server_instance',
        resourceId: removed.connectionId,
        outcome: 'success',
        metadata: {
          appId: removed.catalogEntryId,
          scopeType: removed.scopeType,
          scopeId: removed.scopeId,
        },
      })
      return reply.code(204).send()
    } catch (error) {
      if (sendConnectError(reply, error)) return reply
      throw error
    }
  })
}
