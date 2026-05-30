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
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { createModelClient, createPgPool, ModelUsageTracker } from '@nessie/runtime'
import { sendApiError } from './lib/api.js'
import { createRealtimeHub } from './realtime/hub.js'
import { seedDefaultPolicies } from './services/policy.js'
import { sweepExpiredApprovals } from './services/approvals.js'
import { createThoughtService } from './services/thoughts.js'
import {
  createCorsOriginChecker,
  createServerContext,
  type RequestWithRawBody,
} from './lib/server-context.js'
import type { RouteDeps } from './routes/types.js'
import { registerActivityRoutes } from './routes/activity.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerAuditLogRoutes } from './routes/audit-log.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerCallRoutes } from './routes/calls.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'
import { registerChannelRoutes } from './routes/channels.js'
import { registerDesignerRoutes } from './routes/designer.js'
import { registerExecutionEnvironmentRoutes } from './routes/execution-environments.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerInferenceControlPlaneRoutes } from './routes/inference-control-plane.js'
import { registerLedgerRoutes } from './routes/ledger.js'
import { registerMailboxRoutes } from './routes/mailbox.js'
import { registerMcpRoutes } from './routes/mcp.js'
import { registerPlanRoutes } from './routes/plans.js'
import { registerPolicyRoutes } from './routes/policy.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerResourceLockRoutes } from './routes/resource-locks.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerTeamRoutes } from './routes/teams.js'
import { registerThoughtRoutes } from './routes/thoughts.js'
import { registerThreadRoutes } from './routes/threads.js'
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
  allowedCorsOrigins,
  resolveBootstrapState,
  logBootstrapUrl,
  authenticateRequest,
  requireActorContext,
  requireOwner,
  canAccessChannelRealtimeEvent,
  checkRateLimit,
  disconnectPrismaClient,
} = serverContext

const apiUsageTracker = new ModelUsageTracker()
let sharedModelClient: import('@nessie/runtime').ModelClient | null = null

export const buildApp = async () => {
  const app = Fastify({
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
  const modelApiKey =
    process.env.OPENAI_API_KEY
    ?? process.env.OPENAI_CHAT_API_KEY
    ?? config.model.apiKey
    ?? ''
  if (modelApiKey) {
    sharedModelClient = createModelClient(
      {
        apiKey: modelApiKey,
        provider: (config.model.provider ?? 'openai') as 'openai' | 'minimax' | 'kimi',
      },
      apiUsageTracker,
    )
  } else {
    app.log.warn('No model API key configured — orchestrator, designer, and memory will fail')
  }

  const realtimeHub = await createRealtimeHub({
    canAccessChannelEvent: canAccessChannelRealtimeEvent,
    databaseUrl,
    poolMax: config.database.poolMax,
    poolMin: config.database.poolMin,
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
    origin: createCorsOriginChecker({
      allowedOrigins: allowedCorsOrigins,
      mode: config.mode,
    }),
  })
  await app.register(websocket)

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
  const deps: RouteDeps = {
    ...serverContext,
    realtimeHub,
    sharedModelClient,
    messageMemoryCaptureConfig,
    thoughtService,
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
  registerMailboxRoutes(app, deps)
  registerResourceLockRoutes(app, deps)
  registerToolRoutes(app, deps)
  registerCapabilityRoutes(app, deps)
  registerUserRoutes(app, deps)
  registerProjectRoutes(app, deps)
  registerTeamRoutes(app, deps)
  registerThreadRoutes(app, deps)
  registerActivityRoutes(app, deps)
  registerThoughtRoutes(app, deps)
  registerDesignerRoutes(app, deps)
  registerAuditLogRoutes(app, deps)
  registerPolicyRoutes(app, deps)
  registerApprovalRoutes(app, deps)
  registerTaskRoutes(app, deps)
  registerLedgerRoutes(app, deps)

  // ─── Inference control plane routes ─────────────────────────────────────
  registerInferenceControlPlaneRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  // ─── MCP universal connector routes (Slice C) ──────────────────────────
  // NOTE: `oauthSecretStore` is intentionally omitted until a KMS-backed
  // implementation lands. `registerMcpRoutes` itself enforces the production
  // guard — it will throw at startup when NODE_ENV=production so a misconfigured
  // deploy fails loud instead of silently dropping OAuth tokens.
  registerMcpRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  registerToolBundleRoutes(app, {
    prisma,
    requireActorContext,
    requireOwner,
  })

  // ─── Phase 2: Approval sweep (periodic) ─────────────────────────────────

  // Run approval expiry sweep every 60 seconds
  const approvalSweepInterval = setInterval(async () => {
    try {
      await sweepExpiredApprovals(prisma)
    } catch {
      console.error('[approval-sweep] Failed to sweep expired approvals')
    }
  }, 60_000)

  app.addHook('onClose', () => {
    clearInterval(approvalSweepInterval)
  })

  return app
}

export const startApiServer = async () => {
  const app = await buildApp()
  const initialBootstrapState = await resolveBootstrapState()
  if (initialBootstrapState) {
    logBootstrapUrl(initialBootstrapState)
  }

  await app.listen({
    host: config.api.host,
    port: config.api.port,
  })

  // In local mode, start the worker in-process so agents always work. It shares
  // the API's Prisma client (single pool per process); capture its stop handle so
  // app shutdown tears the worker down instead of leaking it.
  if (config.mode === 'local') {
    const { startWorker } = await import('@nessie/worker')
    const embeddedWorker = await startWorker()
    app.addHook('onClose', async () => {
      await embeddedWorker.stop()
    })
    console.log('[api] embedded worker started (local mode)')
  }

  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApiServer()
}
