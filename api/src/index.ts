import { createSubscriptionSecretStoreFromEnv } from '@nessie/model-subscriptions'
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
  getStorage,
  isLedgerEndpoint,
  ModelUsageTracker,
} from '@nessie/runtime'
import { registerGlobalAuthHook } from './lib/global-auth-hook.js'
import { installApiShutdownHandlers } from './lifecycle.js'
import { createRealtimeHub } from './realtime/hub.js'
import { seedDefaultPolicies } from './services/policy.js'
import { backfillProtectedMcpToolGrants } from './services/agent-tool-policy-registry.js'
import { reconcilePersonalAssistantDefaultToolGrantsAtStartup } from './services/personal-assistant-default-tool-grants.js'
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
import { registerApiRoutes } from './register-api-routes.js'
import type { RouteDeps } from './routes/types.js'
import { registerCommsConnectorsFromEnv } from '@nessie/comms-providers'
import { registerBoardSourceAdaptersFromEnv } from '@nessie/board-source-providers'
import { registerInferenceControlPlaneRoutes } from './routes/inference-control-plane.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerPlatformPushRoutes } from './routes/platform-push.js'
import { registerToolBundleRoutes } from './routes/tools-bundles.js'

export { createCorsOriginChecker } from './lib/server-context.js'

const serverContext = createServerContext()
const {
  config,
  prisma,
  databaseUrl,
  authSecret,
  allowedCorsOrigins,
  teamHostBaseDomain,
  resolveBootstrapState,
  logBootstrapUrl,
  authenticateRequest,
  requireActorContext,
  requireOwner,
  requireSuperAdmin,
  canAccessChannelRealtimeEvent,
  canAccessDashboardRealtimeEvent,
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
    canAccessDashboardEvent: canAccessDashboardRealtimeEvent,
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
    prisma,
  })

  // Memory capture, thought search and the realtime fan-out all speak raw SQL
  // to the same database, so they share the hub's pool rather than opening a
  // second one. Connection ceiling per API replica after this:
  //   Prisma pool (config.database.poolMax, default 10)
  // + this pg.Pool     (config.database.poolMax, default 10)
  // + 1 dedicated LISTEN client held by PgRealtimeTransport
  //   = poolMax * 2 + 1, i.e. 21 by default — down from 31, because the
  //     separate memory pool was a third pool on the same URL. Multiply by
  //     replica count against Postgres `max_connections`, and size with
  //     NESSIE_DB_POOL_MAX / NESSIE_DB_POOL_MIN.
  const memoryPool = realtimeHub.pool
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
      teamHostBaseDomain,
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

  // The worker requires a descriptor-bound ToolGrant for protected MCP tools.
  // Complete the legacy Agent.toolPolicy migration before any route can mutate
  // policy or the local worker can claim a run, so upgrading does not revoke
  // existing Linear/DeepWater access for one startup window.
  const protectedMcpGrantBackfill = await backfillProtectedMcpToolGrants(prisma)
  app.log.info(
    protectedMcpGrantBackfill,
    'Materialized protected MCP tool grants from existing agent policy.',
  )

  const personalAssistantDefaultGrants =
    await reconcilePersonalAssistantDefaultToolGrantsAtStartup(prisma)
  app.log.info(
    personalAssistantDefaultGrants,
    'Provisioned default protected MCP tool grants for Personal Assistants.',
  )

  app.decorateRequest('actorContext', null)

  // Root every Fastify request in its own async context before authentication.
  // Knowledge routes fill in the authenticated actor later; transactional
  // provider hooks then inherit it without concurrent requests sharing state.
  app.addHook('onRequest', (_request, _reply, done) => {
    runKnowledgeInferenceRequestContext(done)
  })

  // Ordering matters and is unchanged: the hub goes first (it stops the LISTEN
  // client before ending the pool it owns — the same pool `memoryPool` aliases,
  // so there is no second `end()` here), then Prisma disconnects.
  app.addHook('onClose', async () => {
    await realtimeHub.close()
    await disconnectPrismaClient()
  })

  registerGlobalAuthHook(app, { authenticateRequest, checkRateLimit, prisma })

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

  // Board-source adapters, into the same shared registry the worker uses, so
  // the OAuth start/callback and the container picker resolve the same
  // adapters that run the sync.
  const boardProviders = registerBoardSourceAdaptersFromEnv(process.env)
  console.log(
    `[api] board-source adapters registered: ${
      boardProviders.length > 0 ? boardProviders.join(', ') : 'none'
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
    mcpSecretStore: createPgSecretStore(prisma, authSecret ?? '', {
      refPrefix: 'secret_mcp_',
    }),
    // Personal model subscriptions live in their own vault project, separate
    // from the general secret store: that folder also holds a person's ordinary
    // captured secrets, and an identity scoped to it could read them all.
    subscriptionSecrets: createSubscriptionSecretStoreFromEnv(),
  }

  registerApiRoutes(app, deps)

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

  // The hub travels with the app because a drain has to reach the live
  // connections it tracks: Fastify's own close leaves in-flight requests alone,
  // and an open SSE stream is an in-flight request (`src/lifecycle.ts`).
  return { app, realtimeHub }
}

export const startApiServer = async () => {
  const { app, realtimeHub } = await buildApp()
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

  return { app, realtimeHub }
}

// Only a standalone API process owns the OS signals — the same guard the worker
// uses (`worker/src/index.ts`), so an embedder that imports `buildApp` keeps its
// own SIGINT/SIGTERM instead of having this drain hijack them.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, realtimeHub } = await startApiServer()
  installApiShutdownHandlers({
    app,
    hub: realtimeHub,
    timeoutMs: config.shutdownTimeoutMs,
  })
}
