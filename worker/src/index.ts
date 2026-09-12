import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createSubscriptionSecretStoreFromEnv } from '@nessie/model-subscriptions'
import { deriveRuntimeCapabilities, loadConfig } from '@nessie/config'
import {
  createDeepSignalMcpIdentityServiceFromEnv,
  createFileService,
  createLedgerIdentityServiceFromEnv,
  createModelClient,
  createPgPool,
  getStorage,
  isLedgerEndpoint,
  PgQueueProvider,
  PgRealtimeTransport,
  recordInferenceUsage,
  type QueueSubscription,
} from '@nessie/runtime'
import { getPrismaClient } from '@nessie/db'
import { releaseSessionsForRun, type CloudBrowserDeps } from '@nessie/browser-cloud'
import { captureTabsForRun } from './run/browser-cloud/tab-capture.js'
import { setCloudBrowserReleaseHook } from './run/browser-cloud/release-hook.js'
import {
  closeTransportsWithDeadline,
  drainQueueSubscriptions,
  memoiseShutdown,
} from './lifecycle.js'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'
import { registerWorkerCoreSubscriptions } from './worker-subscriptions-core.js'
import { registerWorkerIntegrationSubscriptions } from './worker-subscriptions-integrations.js'
import { startWorkerSweeps } from './worker-sweeps.js'

const config = loadConfig()
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = config.database.url
}
const databaseUrl = process.env.DATABASE_URL

const prisma = getPrismaClient({
  connectionLimit: config.database.poolMax,
  log: config.mode === 'local' ? ['warn', 'error'] : ['error'],
})

/**
 * The package entry, so a cross-package test reaches these through
 * `@nessie/worker`'s `dist` export rather than a relative path into
 * `worker/src` (docs/standards/testing.md, "How tests are invoked"): only the
 * Turbo path guarantees the `^build` CI performs, so a source-path import
 * passes locally and fails with ERR_MODULE_NOT_FOUND under `pnpm test`.
 */
export { queueTriggerRun } from './control/trigger-run.js'
export {
  resolveDelegatedRequesterUserId,
  resolveIdentityDelegatedToolIds,
} from './run/delegated-identity.js'

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href

export const startWorker = async (
  options: { standalone?: boolean } = {},
): Promise<{ stop: () => Promise<void> }> => {
  // Only a standalone worker process owns the OS signals. When the api embeds
  // the worker (import('@nessie/worker') + startWorker()), registering signal
  // handlers here would hijack the api's SIGINT/SIGTERM and exit the whole
  // process before Fastify drains and api onClose hooks run.
  const standalone = options.standalone ?? isMainModule()
  const pool = createPgPool(databaseUrl, {
    max: config.database.poolMax,
    min: config.database.poolMin,
  })

  // Postgres is the queue, by decision, not by fallback: the polling loop is
  // correct at N instances and the half-built Pub/Sub adapter beside it was
  // push-mode, could not delay a job, and deduplicated per process
  // (docs/standards/horizontal-scaling/overview.md; audit 5.14). It and the branch that
  // warned about it are gone.
  const queueProvider = new PgQueueProvider(pool)
  const realtimeTransport = new PgRealtimeTransport(pool, databaseUrl)
  // Same chokepoint the api builds (api/src/index.ts) — the worker only ever
  // reads bytes back out (knowledge.extract), it never stores/deletes, but the
  // guardrail is "route all blob file work through FileService", not "only
  // where writes happen".
  const fileService = createFileService({
    prisma,
    storage: getStorage(config.storage),
    maxUploadBytes: config.storage.maxUploadBytes,
    signedDownloadMinBytes: config.storage.signedDownloadMinBytes,
  })
  // The shared model client (orchestrator engagement, memory capture/search/
  // consolidation) bills through the same token ledger as the agentic loop when
  // a call supplies attribution.
  const ledgerIdentity = createLedgerIdentityServiceFromEnv(prisma)
  const deepSignalMcpIdentity =
    createDeepSignalMcpIdentityServiceFromEnv(prisma)
  await deepSignalMcpIdentity?.validateStoredCredentialSeparation()
  // A signer, when this deployment has one, signs every Ledger call below.
  // Without one the Ledger API key stands alone and Ledger enforces whatever
  // that token requires — see `loadLedgerIdentitySettings`.
  if (isLedgerEndpoint(config.model.baseUrl) && !config.model.apiKey) {
    throw new Error(
      'Ledger-routed inference requires NESSIE_MODEL_API_KEY; direct-provider keys are not accepted.',
    )
  }
  // Same reason as the API: the signer is all-or-nothing across five variables,
  // so one typo silently selects the unsigned mode. State which mode booted.
  if (isLedgerEndpoint(config.model.baseUrl)) {
    console.log(
      ledgerIdentity
        ? '[worker.ledger] signing identity configured; calls carry signed provenance.'
        : '[worker.ledger] no signing identity configured; calls authenticate with the '
          + 'Ledger API key alone. Set all five UOA_* variables to enable signing.',
    )
  }
  const modelClient = createModelClient(config.model, {
    embedding: config.embedding,
    recordUsage: async (invocations, attribution) => {
      try {
        await recordInferenceUsage(prisma, { attribution, invocations })
      } catch (err) {
        console.error('[worker.ledger] token usage write failed', err)
      }
    },
    requestHeaders:
      isLedgerEndpoint(config.model.baseUrl) && ledgerIdentity
        ? (attribution) =>
            ledgerIdentity.requestHeaders(attribution, { requireUoaIdentity: true })
        : undefined,
    systemComponent: 'worker-model-service',
  })
  // Vault access for personal model subscriptions. Null when the deployment
  // has not configured the dedicated subscription vault project, which makes
  // every subscription-routed run refuse in words rather than fall back to the
  // organization's Ledger route.
  const subscriptionSecrets = createSubscriptionSecretStoreFromEnv()
  if (!subscriptionSecrets) {
    console.log(
      '[worker.subscriptions] no subscription vault configured; personal model '
      + 'subscriptions are unavailable on this deployment.',
    )
  }
  // MCP credential plumbing shared by the agentic MCP toolset and the
  // personal assistant's connector tools: encrypts assistant-collected
  // secrets at rest, resolves any credentialRef (pg store, then env), and
  // carries the public OAuth callback URL so the assistant can mint sign-in
  // links (config NESSIE_API_PUBLIC_URL in prod; localhost in dev).
  const mcpSecrets = {
    store: createPgSecretStore(prisma, config.auth.secret ?? '', {
      refPrefix: 'secret_mcp_',
    }),
    resolver: createMcpSecretResolver(prisma, config.auth.secret ?? ''),
    oauthCallbackUrl: `${
      config.api.publicUrl ?? `http://localhost:${config.api.port}`
    }/api/mcp/oauth/callback`,
  }
  // Cloud browsers (Browserbase). The resolver is the same layered one MCP
  // uses — a `secret_browserbase_*` ref is an ordinary encrypted secret — and
  // the release hook is what lets `updateRunStatus` free a browser on every
  // terminal transition without any caller participating.
  const cloudBrowser: CloudBrowserDeps = {
    prisma,
    resolveSecret: (ref) => mcpSecrets.resolver.resolve(ref),
    // Lets the reaper write a resumed session's last state before stopping
    // it: nothing drives that session, so the capture dials the capability.
    encryptionSecret: config.auth.secret ?? '',
  }
  setCloudBrowserReleaseHook(async (runId) => {
    // The terminal transition is the last moment the pages exist, and the
    // agent's durable browser keeps what they showed for the chat's Browser
    // column and for the next resume. Bounded and best effort: a picture is
    // never allowed to delay the release that stops the billing.
    await captureTabsForRun(cloudBrowser, runId)
    await releaseSessionsForRun(cloudBrowser, { runId, releasedBy: 'run_terminal' })
  })

  const abortController = new AbortController()
  // Identity is per process, not per host. `HOSTNAME` is unset outside a
  // container — every local worker then shared the label `local-worker` and
  // renewed the others' execution leases — and unique per boot inside one,
  // which left two `execution_runners` rows behind on every restart.
  const workerInstanceId = randomUUID()
  const runnerLabelPrefix = `worker-${workerInstanceId.slice(0, 8)}`
  // Every subscription's handle, so `stop()` can drain them: no new claims,
  // then wait for the jobs already in flight before anything is closed.
  const subscriptions: QueueSubscription[] = []
  const subscribe: PgQueueProvider['subscribe'] = (topic, handler, subscribeOptions) => {
    const subscription = queueProvider.subscribe(topic, handler, subscribeOptions)
    subscriptions.push(subscription)
    return subscription
  }
  const automaticMembershipEnabled = registerWorkerCoreSubscriptions({
    abortSignal: abortController.signal,
    cloudBrowser,
    config,
    deepSignalMcpIdentity,
    fileService,
    ledgerIdentity,
    mcpSecrets,
    modelClient,
    pool,
    prisma,
    queueProvider,
    realtimeTransport,
    runnerLabelPrefix,
    subscribe,
    subscriptionSecrets,
  })
  await registerWorkerIntegrationSubscriptions({
    abortSignal: abortController.signal,
    config,
    fileService,
    prisma,
    realtimeTransport,
    runnerLabelPrefix,
    subscribe,
  })
  const sweeps = startWorkerSweeps({
    abortSignal: abortController.signal,
    automaticMembershipEnabled,
    cloudBrowser,
    pool,
    prisma,
    realtimeTransport,
    runnerLabelPrefix,
  })

  console.log(
    JSON.stringify(
      {
        service: 'worker',
        mode: config.mode,
        capabilities: deriveRuntimeCapabilities(config),
        queueProvider: config.queue.provider,
        status: 'ready',
      },
      null,
      2,
    ),
  )

  // Memoised, so the second signal joins the first shutdown instead of starting
  // a second drain and a second `pool.end()` — pg rejects that one, and the
  // signal handler's floating promise turned the rejection into an unhandled
  // rejection that ends the process mid-drain.
  const stop = memoiseShutdown(async () => {
    // Drain before anything closes (audit 5.1): `stop()` used to abort and end
    // the pool while a handler was still running, so a long run died
    // mid-inference with its terminal writes throwing on a closed pool.
    //
    // First act, before the sweeps are even cleared: stop claiming and raise
    // every in-flight job's `context.signal`. That abort is the only warning a
    // long handler gets, and it is worth nothing if it arrives at the deadline
    // instead of at the start of the grace window.
    for (const subscription of subscriptions) {
      subscription.stop()
    }
    sweeps.stop()
    const { settleTimedOut, timedOut } = await drainQueueSubscriptions(subscriptions)
    if (timedOut) {
      console.warn(
        '[worker.drain] deadline reached with handlers still in flight; their jobs were '
        + 'released so another worker can claim them now.',
      )
    }
    if (settleTimedOut) {
      console.warn(
        '[worker.drain] an abandoned handler was still writing when its settle window '
        + 'expired; the pool closes under it and its last writes are lost.',
      )
    }
    // Only once the drain is over — including the settle window above. Nothing
    // below may run while a handler still holds the pool: closing it under one
    // is what left a released run looking held by a live executor.
    abortController.abort()
    modelClient.close()
    // ...and under a hard deadline, because the wait above is bounded and this
    // one was not: `pool.end()` resolves only when every checked-out client is
    // back, so a handler already written off at the settle window — parked on a
    // row lock its successor now holds — would keep the process alive until the
    // platform SIGKILLed it, defeating the bound the settle window exists to
    // provide.
    await closeTransportsWithDeadline([
      { close: () => realtimeTransport.close(), label: 'realtime transport' },
      { close: () => pool.end(), label: 'postgres pool' },
      { close: () => prisma.$disconnect(), label: 'prisma client' },
    ])
  })

  if (standalone) {
    // `.catch` before `.finally`, not a bare floating promise: a shutdown that
    // throws must be logged and still exit, never surface as an unhandled
    // rejection that kills the process ahead of its own teardown.
    const shutdown = (signal: string): void => {
      void stop()
        .catch((error: unknown) => {
          console.error(`[worker.shutdown] ${signal} shutdown failed`, error)
        })
        .finally(() => process.exit(0))
    }

    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
  }

  return { stop }
}

if (isMainModule()) {
  await startWorker({ standalone: true })
}
