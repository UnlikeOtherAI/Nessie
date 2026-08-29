import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// Load .env from project root (parent of api/) before config is parsed
const envFile = resolve(import.meta.dirname, '../../.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = val
  }
}
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import {
  createFileService,
  createDeepSignalMcpIdentityServiceFromEnv,
  createLedgerIdentityServiceFromEnv,
  createModelClient,
  createPgPool,
  getStorage,
  isLedgerEndpoint,
  ModelUsageTracker,
} from '@nessie/runtime'
import { sendApiError } from './lib/api.js'
import { createRealtimeHub } from './realtime/hub.js'
import { seedDefaultPolicies } from './services/policy.js'
import {
  runRefreshCredentialSweep,
  startApiMaintenance,
} from './services/api-maintenance.js'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'
import { createThoughtService } from './services/thoughts.js'
import { runKnowledgeInferenceRequestContext } from './services/knowledge-inference-origin.js'
import { recordModelUsage } from './services/model-usage-recorder.js'
import {
  createCorsOriginChecker,
  createFastifyTrustProxyConfig,
  createServerContext,
  type RequestWithRawBody,
} from './lib/server-context.js'
import type { RouteDeps } from './routes/types.js'
import { registerActivityRoutes } from './routes/activity.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerAlertRoutes } from './routes/alerts.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerAuditLogRoutes } from './routes/audit-log.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerCallRoutes } from './routes/calls.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'
import { registerChannelRoutes } from './routes/channels.js'
import { registerDesignerRoutes } from './routes/designer.js'
import { registerDeviceRoutes } from './routes/devices.js'
import { registerWebPushRoutes } from './routes/web-push.js'
import { registerCommsConnectionRoutes } from './routes/comms-connections.js'
import { registerCommsWebhookRoutes } from './routes/comms-webhooks.js'
import { registerCommsConnectorsFromEnv } from '@nessie/comms-providers'
import { registerEventRoutes } from './routes/events.js'
import { registerExecutionEnvironmentRoutes } from './routes/execution-environments.js'
import { registerExecutorRoutes } from './routes/executors.js'
import { registerFavoriteRoutes } from './routes/favorites.js'
import { registerDashboardRoutes } from './routes/dashboards.js'
import {
  buildDashboardEgressPolicy,
  createDashboardCredentialStore,
} from './services/dashboard-runtime.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerInferenceControlPlaneRoutes } from './routes/inference-control-plane.js'
import { registerIntegrationRoutes } from './routes/integrations.js'
import { registerExternalAgentRoutes } from './routes/external-agent.js'
import { registerKnowledgeBaseRoutes } from './routes/knowledge-base.js'
import { registerKnowledgeBaseFileRoutes } from './routes/knowledge-base-files.js'
import { registerKnowledgeCommentRoutes } from './routes/knowledge-comments.js'
import { registerKnowledgeLibrarianRoutes } from './routes/knowledge-librarian.js'
import { registerKnowledgeLinkRoutes } from './routes/knowledge-links.js'
import { registerKnowledgeRecentPagesRoutes } from './routes/knowledge-recent-pages.js'
import { registerKnowledgeSummaryRoutes } from './routes/knowledge-summary.js'
import { registerKnowledgeTaskRoutes } from './routes/knowledge-tasks.js'
import { registerLedgerRoutes } from './routes/ledger.js'
import { registerDisclosureGrantRoutes } from './routes/disclosure-grants.js'
import { registerMailboxRoutes } from './routes/mailbox.js'
import { registerFeedbackRoutes } from './routes/feedback.js'
import { registerAppRoutes } from './routes/apps.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerOrganizationRoutes } from './routes/organizations.js'
import { registerWorkspaceAvatarRoutes } from './routes/workspace-avatar.js'
import { registerWorkspaceMembersRoutes } from './routes/workspace-members.js'
import { registerPlatformPushRoutes } from './routes/platform-push.js'
import { registerPlanRoutes } from './routes/plans.js'
import { registerPolicyRoutes } from './routes/policy.js'
import { registerBoardRoutes } from './routes/board.js'
import { registerBillingRoutes } from './routes/billing.js'
import { registerIterationRoutes } from './routes/iterations.js'
import { registerPresenceRoutes } from './routes/presence.js'
import { registerProfileAvatarRoutes } from './routes/profile-avatar.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerResourceLockRoutes } from './routes/resource-locks.js'
import { registerRunRoutes } from './routes/runs.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerStatusRoutes } from './routes/statuses.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerTeamRoutes } from './routes/teams.js'
import { registerThoughtRoutes } from './routes/thoughts.js'
import { registerThreadRoutes } from './routes/threads.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerToolBundleRoutes } from './routes/tools-bundles.js'
import { registerToolRoutes } from './routes/tools.js'
import { registerTriggerRoutes } from './routes/triggers.js'
import { registerUserRoutes } from './routes/users.js'
import { registerWorkflowRoutes } from './routes/workflows.js'

export { createCorsOriginChecker } from './lib/server-context.js'

const serverContext = createServerContext()
const {
  config,
  prisma,
  databaseUrl,
  authSecret,
  allowedCorsOrigins,
  resolveBootstrapState,
  logBootstrapUrl,
  authenticateRequest,
  requireActorContext,
  requireOwner,
  requireSuperAdmin,
  canAccessChannelRealtimeEvent,
  checkRateLimit,
  rateLimiter,
  disconnectPrismaClient,
} = serverContext

const apiUsageTracker = new ModelUsageTracker()
let sharedModelClient: import('@nessie/runtime').ModelClient | null = null

export const buildApp = async () => {
  let ledgerIdentity: import('@nessie/runtime').LedgerIdentityService | null = null
  const app = Fastify({
    trustProxy: createFastifyTrustProxyConfig(config.api.trustedProxyHops),
    logger: {
      // Redact the `token` query param (used by the WebSocket upgrade path
      // because the browser WS API cannot set headers) from access logs.
      redact: {
        paths: ['req.url'],
        censor: (value: unknown) =>
          typeof value === 'string'
            ? value.replace(/([?&])token=[^&]*/gi, '$1token=[REDACTED]')
            : value,
      },
    },
  })

  app.addContentTypeParser(
    /^application\/([a-z0-9.+-]+\+)?json($|;)/i,
    { parseAs: 'buffer' },
    (request, body, done) => {
      ;(request as RequestWithRawBody).rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body)

      if (body.length === 0) {
        done(null, null)
        return
      }

      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (error) {
        done(error as Error)
      }
    },
  )

  // Create a single shared model client for all LLM calls (orchestrator, designer, memory)
  const modelApiKey = isLedgerEndpoint(config.model.baseUrl)
    ? config.model.apiKey ?? ''
    : config.model.apiKey
      ?? process.env.OPENAI_API_KEY
      ?? process.env.OPENAI_CHAT_API_KEY
      ?? ''
  if (modelApiKey) {
    // Signing is attached whenever this deployment has a signer; without one the
    // Ledger API key is the whole credential and Ledger decides for itself
    // whether that token also demands signed provenance.
    const configuredLedgerIdentity = createLedgerIdentityServiceFromEnv(prisma)
    ledgerIdentity = configuredLedgerIdentity
    // Say which of the two modes this process actually resolved. The signer is
    // all-or-nothing across five variables, so a single typo silently produces
    // the unsigned mode; an operator who meant to sign needs to see that at boot
    // rather than infer it from missing provenance later.
    if (isLedgerEndpoint(config.model.baseUrl)) {
      app.log.info(
        configuredLedgerIdentity
          ? 'Ledger inference: signing identity configured; calls carry signed provenance.'
          : 'Ledger inference: no signing identity configured; calls authenticate with '
            + 'the Ledger API key alone. Set all five UOA_* variables to enable signing.',
      )
    }
    sharedModelClient = createModelClient(
      {
        ...config.model,
        apiKey: modelApiKey,
      },
      {
        embedding: config.embedding,
        tracker: apiUsageTracker,
        recordUsage: (invocations, attribution) =>
          recordModelUsage(prisma, app.log, invocations, attribution),
        requestHeaders:
          isLedgerEndpoint(config.model.baseUrl) && configuredLedgerIdentity
            ? (attribution) =>
                configuredLedgerIdentity.requestHeaders(attribution, {
                  requireUoaIdentity: true,
                })
            : undefined,
        systemComponent: 'api-model-service',
      },
    )
  } else {
    if (isLedgerEndpoint(config.model.baseUrl)) {
      throw new Error(
        'Ledger-routed inference requires NESSIE_MODEL_API_KEY; direct-provider keys are not accepted.',
      )
    }
    app.log.warn('No model API key configured — orchestrator, designer, and memory will fail')
  }

  const realtimeHub = await createRealtimeHub({
    canAccessChannelEvent: canAccessChannelRealtimeEvent,
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
    prisma,
  })

  const memoryPool = createPgPool(databaseUrl, {
    max: config.database.poolMax,
    min: config.database.poolMin,
  })
  const messageMemoryCaptureConfig = sharedModelClient
    ? { pool: memoryPool, modelClient: sharedModelClient }
    : null
  const thoughtService = sharedModelClient
    ? createThoughtService({
      pool: memoryPool,
      captureConfig: { pool: memoryPool, modelClient: sharedModelClient },
      searchConfig: { pool: memoryPool, modelClient: sharedModelClient },
    })
    : null

  if (config.mode !== 'local' && allowedCorsOrigins.size === 0) {
    app.log.warn('No CORS allowlist configured; browser cross-origin requests will be denied')
  }

  await app.register(cors, {
    credentials: true,
    // @fastify/cors v11 defaults `methods` to the CORS-safelist (GET,HEAD,POST),
    // which silently 405s every cross-origin PATCH/PUT/DELETE preflight. Pin the
    // full verb set the API actually serves.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin: createCorsOriginChecker({
      allowedOrigins: allowedCorsOrigins,
      mode: config.mode,
    }),
  })
  await app.register(cookie)
  await app.register(websocket)
  // File uploads / attachments slice. The ceiling is the configured max upload
  // (default 5 GiB) so large file nodes can stream through; chat/avatar routes
  // re-impose a smaller per-route limit via request.file({ limits }).
  await app.register(multipart, {
    limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
  })

  // Baseline security response headers on every API response. The API serves
  // JSON (no HTML document), so there is no CSP here — the admin SPA's CSP lives
  // at its nginx edge. This does not touch CORS (owned by @fastify/cors above)
  // and does not run for hijacked SSE streams (which manage their own headers),
  // so realtime is unaffected. `Cross-Origin-Resource-Policy: cross-origin` is
  // required so the admin, served from a different origin, can read responses.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin')
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    reply.removeHeader('X-Powered-By')
    return payload
  })

  // Self-heal: ensure every pre-existing organization has the default policy
  // rules seeded. Bootstrap only runs on first install, so orgs provisioned
  // through migrations or older installs otherwise hit NO_MATCHING_ALLOW on
  // every agent bind / invoke. seedDefaultPolicies is idempotent per-org.
  try {
    const orgs = await prisma.organization.findMany({
      select: {
        id: true,
        members: {
          where: { role: 'owner' },
          select: { userId: true },
          take: 1,
        },
      },
    })
    for (const org of orgs) {
      const createdBy = org.members[0]?.userId ?? org.id
      await seedDefaultPolicies(prisma, org.id, createdBy)
    }
  } catch (error) {
    app.log.error({ err: error }, 'Failed to seed default policies on startup')
  }

  app.decorateRequest('actorContext', null)

  // Root every Fastify request in its own async context before authentication.
  // Knowledge routes fill in the authenticated actor later; transactional
  // provider hooks then inherit it without concurrent requests sharing state.
  app.addHook('onRequest', (_request, _reply, done) => {
    runKnowledgeInferenceRequestContext(done)
  })

  app.addHook('onClose', async () => {
    await realtimeHub.close()
    await memoryPool.end()
    await disconnectPrismaClient()
  })

  app.addHook('preHandler', async (request, reply) => {
    const rateLimit = checkRateLimit(request)
    if (rateLimit) {
      reply.header('retry-after', String(rateLimit.retryAfterSeconds))
      sendApiError(reply, 429, 'RATE_LIMITED', 'Too many requests')
      return
    }

    if (request.routeOptions.config.public === true) {
      return
    }

    await authenticateRequest(request, reply)
  })

  // Per-domain route modules. Each `register<Domain>Routes(app, deps)` closes
  // over the shared `RouteDeps` (server context + buildApp-local resources),
  // replacing the implicit closures these handlers used while inlined here.
  const fileService = createFileService({
    prisma,
    storage: getStorage(config.storage),
    maxUploadBytes: config.storage.maxUploadBytes,
  })
  const deepSignalMcpIdentity =
    createDeepSignalMcpIdentityServiceFromEnv(prisma)
  await deepSignalMcpIdentity?.validateStoredCredentialSeparation()

  // Wire the Individual Communications Connector adapters into the shared
  // registry so the OAuth callback (`connect`) and disconnect paths resolve.
  const commsProviders = registerCommsConnectorsFromEnv(process.env)
  console.log(
    `[api] comms connectors registered: ${
      commsProviders.length > 0 ? commsProviders.join(', ') : 'none'
    }`,
  )

  const deps: RouteDeps = {
    ...serverContext,
    realtimeHub,
    sharedModelClient,
    messageMemoryCaptureConfig,
    thoughtService,
    ledgerIdentity,
    deepSignalMcpIdentity,
    fileService,
  }

  registerHealthRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerChannelRoutes(app, deps)
  registerCallRoutes(app, deps)
  registerAgentRoutes(app, deps)
  registerTriggerRoutes(app, deps)
  registerPlanRoutes(app, deps)
  registerWorkflowRoutes(app, deps)
  registerExecutionEnvironmentRoutes(app, deps)
  registerDisclosureGrantRoutes(app, deps)
  registerExecutorRoutes(app, deps)
  registerMailboxRoutes(app, deps)
  registerResourceLockRoutes(app, deps)
  registerRunRoutes(app, deps)
  registerToolRoutes(app, deps)
  // File uploads / attachments slice (Slack-parity files).
  registerUploadRoutes(app, deps)
  registerDeviceRoutes(app, deps)
  registerWebPushRoutes(app, deps)
  registerCommsConnectionRoutes(app, deps)
  registerCommsWebhookRoutes(app, deps)
  registerCapabilityRoutes(app, deps)
  registerUserRoutes(app, deps)
  registerStatusRoutes(app, deps)
  registerPresenceRoutes(app, deps)
  registerFavoriteRoutes(app, deps)
  registerDashboardRoutes(app, {
    ...deps,
    // Nessie's own origins are denied as dashboard sources: the SSRF guard
    // stops private addresses, but a plain HTTPS call to our own REST surface
    // would carry a source credential instead of the viewer's session.
    egressPolicy: buildDashboardEgressPolicy({
      apiPublicUrl: config.api.publicUrl ?? null,
    }),
    credentials: createDashboardCredentialStore(prisma, authSecret ?? ''),
  })
  registerAlertRoutes(app, deps)
  registerOrganizationRoutes(app, deps)
  registerWorkspaceAvatarRoutes(app, deps)
  registerProfileAvatarRoutes(app, deps)
  registerWorkspaceMembersRoutes(app, deps)
  registerFeedbackRoutes(app, deps)
  registerAppRoutes(app, deps)
  registerIntegrationRoutes(app, deps)
  registerExternalAgentRoutes(app, deps)
  registerProjectRoutes(app, deps)
  registerBoardRoutes(app, deps)
  registerIterationRoutes(app, deps)
  registerTeamRoutes(app, deps)
  registerEventRoutes(app, deps)
  registerThreadRoutes(app, deps)
  registerSearchRoutes(app, deps)
  registerActivityRoutes(app, deps)
  registerThoughtRoutes(app, deps)
  registerDesignerRoutes(app, deps)
  registerAuditLogRoutes(app, deps)
  registerPolicyRoutes(app, deps)
  registerApprovalRoutes(app, deps)
  registerKnowledgeBaseRoutes(app, deps)
  registerKnowledgeBaseFileRoutes(app, deps)
  registerKnowledgeCommentRoutes(app, deps)
  registerKnowledgeLibrarianRoutes(app, deps)
  registerKnowledgeLinkRoutes(app, deps)
  registerKnowledgeRecentPagesRoutes(app, deps)
  registerKnowledgeSummaryRoutes(app, deps)
  registerKnowledgeTaskRoutes(app, deps)
  registerTaskRoutes(app, deps)
  registerBillingRoutes(app, deps)
  registerLedgerRoutes(app, deps)

  // ─── Inference control plane routes ─────────────────────────────────────
  registerInferenceControlPlaneRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  // ─── MCP universal connector routes (Slice C) ──────────────────────────
  // Inject a persistent, encrypted SecretStore so completing an OAuth handshake
  // durably stores the token bundle (AES-256-GCM, keyed off the auth secret)
  // instead of dropping it. `registerMcpRoutes` still enforces the production
  // guard — a deploy without this store fails loud at startup.
  registerMcpRoutes(app, {
    prisma,
    config,
    rateLimiter,
    requireActorContext,
    requireOwner,
    oauthSecretStore: createPgSecretStore(prisma, authSecret ?? ''),
    // Probe/test paths resolve credentialRefs through the same layered
    // resolver the worker uses (encrypted pg store first, env fallback), so
    // OAuth tokens and assistant-collected secrets work for connection tests.
    secretResolver: createMcpSecretResolver(prisma, authSecret ?? ''),
    mcpSecretStore: createPgSecretStore(prisma, authSecret ?? '', {
      refPrefix: 'secret_mcp_',
    }),
  })

  registerToolBundleRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  // ─── Platform push-credentials surface (super-admin only) ──────────────
  // Apple/Google credentials for the central push gateway. Secret bytes are
  // stored encrypted via the SecretStore (keyed off the auth secret) and are
  // write-only; only metadata is ever returned.
  registerPlatformPushRoutes(app, {
    prisma,
    requireActorContext,
    requireSuperAdmin,
    encryptionSecret: authSecret ?? '',
  })

  const stopApiMaintenance = startApiMaintenance(prisma)
  app.addHook('onClose', () => {
    stopApiMaintenance()
  })

  return app
}

export const startApiServer = async () => {
  const app = await buildApp()
  await runRefreshCredentialSweep(prisma, true)
  const initialBootstrapState = await resolveBootstrapState()
  if (initialBootstrapState) {
    logBootstrapUrl(initialBootstrapState)
  }

  // In local mode, start the worker in-process so agents always work. It shares
  // the API's Prisma client (single pool per process); capture its stop handle so
  // app shutdown tears the worker down instead of leaking it. Register the onClose
  // hook BEFORE app.listen() — Fastify rejects addHook once the server is listening.
  if (config.mode === 'local') {
    const { startWorker } = await import('@nessie/worker')
    const embeddedWorker = await startWorker()
    app.addHook('onClose', async () => {
      await embeddedWorker.stop()
    })
    console.log('[api] embedded worker started (local mode)')
  }

  await app.listen({
    host: config.api.host,
    port: config.api.port,
  })

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApiServer()
}
