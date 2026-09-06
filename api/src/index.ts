import { createSubscriptionSecretStoreFromEnv } from '@nessie/model-subscriptions'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
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
} from '@nessie/runtime'
import { registerGlobalAuthHook } from './lib/global-auth-hook.js'
import { registerRawBodyJsonParser } from './lib/raw-body-json-parser.js'
import { registerApiErrorHandler } from './lib/error-handler.js'
import { createLifecycleState, installApiShutdownHandlers } from './lifecycle.js'
import { createRealtimeHub } from './realtime/hub.js'
import { runReconcile } from './db/reconcile-cli.js'
import { startApiMaintenance } from './services/api-maintenance.js'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'
import { createThoughtService } from './services/thoughts.js'
import { runKnowledgeInferenceRequestContext } from './services/knowledge-inference-origin.js'
import { recordModelUsage } from './services/model-usage-recorder.js'
import {
  createCorsOriginChecker,
  createFastifyTrustProxyConfig,
  createServerContext,
  ServerConfigurationError,
  type ServerContext,
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

/**
 * Fold the repo-root `.env` into `process.env` before any config is parsed.
 *
 * This used to run at module scope, which made importing this file — for
 * `createCorsOriginChecker`, or for a test that wanted `buildApp` — read the
 * filesystem and mutate the environment (2026-09-05 review, FO3-5). It now
 * runs only on the paths that are about to construct a server context. Keys
 * already present in the environment always win, so calling it twice is a
 * no-op.
 */
const loadRootEnvFile = (): void => {
  const envFile = resolve(import.meta.dirname, '../../.env')
  if (!existsSync(envFile)) return
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

/**
 * The composition root: `.env`, then config, then the Prisma pool and every
 * auth helper built over it. Nothing here happens at import time — an importer
 * of this module gets functions, not a database connection.
 */
const createDefaultServerContext = (): ServerContext => {
  loadRootEnvFile()
  return createServerContext()
}

export const buildApp = async (
  options: { serverContext?: ServerContext } = {},
) => {
  const serverContext = options.serverContext ?? createDefaultServerContext()
  const {
    config,
    prisma,
    databaseUrl,
    authSecret,
    allowedCorsOrigins,
    teamHostBaseDomain,
    authenticateRequest,
    requireActorContext,
    requireOwner,
    requireSuperAdmin,
    canAccessChannelRealtimeEvent,
    canAccessDashboardRealtimeEvent,
    rateLimiter,
    disconnectPrismaClient,
  } = serverContext

  let sharedModelClient: import('@nessie/runtime').ModelClient | null = null
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
  registerApiErrorHandler(app)
  registerRawBodyJsonParser(app)

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
        // No `tracker`: the API constructed a process-wide usage accumulator
        // here and never read a byte of it (audit 1.12). `recordUsage` writes
        // the durable ledger, which is the authority; the model client still
        // keeps its own counters for the callers that read `client.usage`.
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
    logger: app.log,
    // A revocation announced by any replica drops the sid from this one's
    // cache immediately; the 30 s TTL stays as the backstop for a replica
    // whose LISTEN was down when the NOTIFY went out.
    onSessionRevoked: serverContext.invalidateSessionRevocationCache,
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

  // Boot connects and listens — nothing else. Policy seeding, the protected-MCP
  // grant backfill, Personal Assistant default grants and the credential sweep
  // all used to run here, on every replica, before `listen()`; they now run once
  // per deploy from `pnpm --filter @nessie/api reconcile`
  // (docs/standards/horizontal-scaling.md §5).

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

  registerGlobalAuthHook(app, { authenticateRequest, config, prisma, rateLimiter })

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

  // This server's drain flag: created here, read by the health routes, flipped
  // by the drain. One per built app, so an embedder hosting two of them drains
  // them independently (`src/lifecycle.ts`).
  const lifecycle = createLifecycleState()

  const deps: RouteDeps = {
    ...serverContext,
    lifecycle,
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

  // The hub and the drain flag travel with the app because a drain has to reach
  // the live connections the hub tracks (Fastify's own close leaves in-flight
  // requests alone, and an open SSE stream is an in-flight request) and has to
  // flip the flag the health routes read (`src/lifecycle.ts`).
  return { app, lifecycle, realtimeHub }
}

export const startApiServer = async () => {
  let serverContext: ServerContext
  try {
    serverContext = createDefaultServerContext()
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      // The refusal that used to be a `process.exit(1)` inside
      // `createServerContext`. It still ends the process — but now only when a
      // process is actually being started, not when the module is imported.
      console.error(`[FATAL] ${error.message}`)
      process.exit(1)
    }
    throw error
  }
  const { config, logBootstrapUrl, prisma, resolveBootstrapState } = serverContext

  const { app, lifecycle, realtimeHub } = await buildApp({ serverContext })
  const initialBootstrapState = await resolveBootstrapState()
  if (initialBootstrapState) {
    logBootstrapUrl(initialBootstrapState)
  }

  // In local mode, start the worker in-process so agents always work. It shares
  // the API's Prisma client (single pool per process); capture its stop handle so
  // app shutdown tears the worker down instead of leaking it. Register the onClose
  // hook BEFORE app.listen() — Fastify rejects addHook once the server is listening.
  if (config.mode === 'local') {
    // The one documented exception to "boot connects and listens": local mode is
    // a single developer instance with no deploy step to hang the reconcile job
    // off, and it already embeds the worker below for the same reason. Every
    // other mode runs `pnpm --filter @nessie/api reconcile` after
    // `migrate deploy` (docs/standards/horizontal-scaling.md §5).
    await runReconcile(prisma, (message) => {
      console.log(`[reconcile] ${message}`)
    })
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

  // `config` travels with the result because the composition root no longer
  // keeps one at module scope: the signal handler below needs the shutdown
  // deadline, and this process's config is only knowable from here.
  return { app, config, lifecycle, realtimeHub }
}

// Only a standalone API process owns the OS signals — the same guard the worker
// uses (`worker/src/index.ts`), so an embedder that imports `buildApp` keeps its
// own SIGINT/SIGTERM instead of having this drain hijack them.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, config, lifecycle, realtimeHub } = await startApiServer()
  installApiShutdownHandlers({
    app,
    hub: realtimeHub,
    lifecycle,
    timeoutMs: config.shutdownTimeoutMs,
  })
}
