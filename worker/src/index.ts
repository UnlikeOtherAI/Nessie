import { createSubscriptionSecretStoreFromEnv } from '@nessie/model-subscriptions'
import { sweepDueGmailSends } from './control/gmail-send-sweep.js'
import { pathToFileURL } from 'node:url'
import { deriveRuntimeCapabilities, loadConfig } from '@nessie/config'
import {
  createFileService,
  createDeepSignalMcpIdentityServiceFromEnv,
  createLedgerIdentityServiceFromEnv,
  createModelClient,
  createPgPool,
  getStorage,
  isLedgerEndpoint,
  PgQueueProvider,
  PgRealtimeTransport,
  recordInferenceUsage,
} from '@nessie/runtime'
import {
  COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  COMMS_SYNC_INCREMENTAL_TOPIC,
  COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC,
  COMMS_SYNC_INITIAL_TOPIC,
  COMMS_WEBHOOK_PROCESS_TOPIC,
  AttachmentThumbnailJobPayloadSchema,
  AttentionDispatchJobPayloadSchema,
  ATTACHMENT_THUMBNAIL_TOPIC,
  CommsSubscriptionsRenewJobPayloadSchema,
  CommsIncrementalSweepJobPayloadSchema,
  CommsSyncIncrementalJobPayloadSchema,
  CommsSyncInitialJobPayloadSchema,
  CommsWebhookProcessJobPayloadSchema,
  ExecutionEnvironmentAllocateJobPayloadSchema,
  ExecutionEnvironmentTerminateJobPayloadSchema,
  KNOWLEDGE_EMBED_TOPIC,
  KNOWLEDGE_EXTRACT_TOPIC,
  KnowledgeEmbedJobPayloadSchema,
  KnowledgeExtractJobPayloadSchema,
  AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
  AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
  AUTOMATIC_MEMBERSHIP_REVALIDATE_TOPIC,
  AutomaticMembershipProvisionJobPayloadSchema,
  AutomaticMembershipReconcileJobPayloadSchema,
  AutomaticMembershipRevalidateJobPayloadSchema,
  BudgetAlertDispatchJobPayloadSchema,
  TriggerHealthAlertJobPayloadSchema,
  WorkflowRunFailureDispatchJobPayloadSchema,
  CallRingCancelJobPayloadSchema,
  CallRingDispatchJobPayloadSchema,
  DEMONSTRATION_GENERALIZE_TOPIC,
  DemonstrationGeneralizeJobPayloadSchema,
  OrchestrateDecideJobPayloadSchema,
  PushDispatchJobPayloadSchema,
  RunExecuteJobPayloadSchema,
  TriggerEventDispatchJobPayloadSchema,
  WorkflowRunExecuteJobPayloadSchema,
} from '@nessie/schemas'
import { getPrismaClient } from '@nessie/db'
import {
  expireStaleControlClaims,
  reapExpiredCloudBrowserSessions,
  reconcileTombstonedAgentBrowsers,
  releaseSessionsForRun,
  type CloudBrowserDeps,
} from '@nessie/browser-cloud'
import { setCloudBrowserReleaseHook } from './run/browser-cloud/release-hook.js'
import {
  allocateExecutionEnvironmentInstance,
  expireExecutionLeases,
  registerExecutionRunners,
  renewExecutionLeases,
  terminateExecutionEnvironmentInstance,
} from './control/execution.js'
import { executeAttachmentThumbnailJob } from './control/attachment-thumbnail.js'
import { generalizeDemonstration } from './control/demonstration-generalize.js'
import { DASHBOARD_REFRESH_TOPIC } from '@nessie/dashboard'
import {
  refreshDashboardDataSource,
  sweepDueDashboardSources,
} from './control/dashboard-refresh.js'
import { executeAutomaticMembershipProvisionJob } from './control/automatic-membership/provision.js'
import { executeAutomaticMembershipReconcileJob } from './control/automatic-membership/reconcile.js'
import {
  executeAutomaticMembershipRevalidateJob,
  sweepDueDomainRevalidations,
  sweepStrandedReconciliations,
  REVALIDATION_SWEEP_INTERVAL_MS,
} from './control/automatic-membership/revalidate.js'
import { executeKnowledgeEmbedJob } from './control/knowledge-embed.js'
import { executeKnowledgeExtractJob } from './control/knowledge-extract.js'
import { dispatchNextMailboxMessage, reclaimExpiredMailboxMessages } from './control/mailbox.js'
import { maybeSyncRegistry } from './control/registry-sync-sweep.js'
import { assertValidVapidSubject, loadVapidPrivateKey } from '@nessie/push'
import { handlePushDispatch } from './control/push-dispatch.js'
import { handleBudgetAlertDispatch } from './control/budget-alert-dispatch.js'
import { handleTriggerHealthAlert } from './control/trigger-health-dispatch.js'
import { handleWorkflowRunFailureDispatch } from './control/workflow-failure-dispatch.js'
import { handleAttentionDispatch } from './control/attention-dispatch.js'
import {
  dispatchEventTriggers,
  reattemptTriggerDelivery,
  retryFailedTriggerDeliveries,
  sweepDueScheduledTriggers,
} from './control/triggers.js'
import { executeWorkflowRun } from './control/workflows.js'
import { reapStuckWorkflowSteps } from './control/workflow-step-reaper.js'
import { executeRunJob } from './run/execute.js'
import {
  executeRunMemoryConsolidationJob,
  MEMORY_CONSOLIDATION_TOPIC,
} from './run/memory-consolidation.js'
import { createMcpSecretResolver, createPgSecretStore } from '@nessie/mcp-manage'

import { executeOrchestrateDecideJob } from './run/orchestrate.js'
import { sweepPendingThreadMessages } from './run/thread-serialization.js'
import {
  executeCommsIncrementalSyncJob,
  executeCommsIncrementalSweepJob,
  executeCommsInitialSyncJob,
  renewCommsSubscriptions,
} from './control/comms-sync.js'
import { processCommsWebhookJob } from './control/comms-webhook.js'
import {
  processAgentEmailInboundJob,
  processAgentEmailRetentionJob,
  processAgentEmailSendJob,
  type AgentEmailJobDeps,
} from './control/agent-email/jobs.js'
import { createAgentMailTransport, resolveAgentMailReadiness } from '@nessie/agent-mail'
import {
  AGENT_EMAIL_INBOUND_TOPIC,
  AGENT_EMAIL_RETENTION_TOPIC,
  AGENT_EMAIL_SEND_TOPIC,
  AgentEmailInboundJobPayloadSchema,
  AgentEmailRetentionJobPayloadSchema,
  AgentEmailSendJobPayloadSchema,
} from '@nessie/schemas'
import { registerCommsConnectorsFromEnv } from '@nessie/comms-providers'
import { registerBoardSourceAdaptersFromEnv } from '@nessie/board-source-providers'
import {
  BOARD_SOURCE_HEALTH_ALERT_TOPIC,
  BOARD_SOURCE_SYNC_INCREMENTAL_TOPIC,
  BOARD_SOURCE_SYNC_INITIAL_TOPIC,
  BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
  BoardSourceSyncJobPayloadSchema,
  BoardSourceWebhookJobPayloadSchema,
  BoardSourceHealthAlertJobPayloadSchema,
  parseOrganizationId,
} from '@nessie/schemas'
import {
  executeBoardSourceSync,
  sweepDueBoardSources,
} from './control/board-source-sync.js'
import { processBoardSourceWebhook } from './control/board-source-webhook.js'
import { writeHealthAlerts } from './control/board-source-health.js'
import { enqueueBoardSourceHealthAlert, enqueueBoardSourceSync } from './queue.js'
import { listIncrementalPollingConnectors } from '@nessie/comms-connect'
import {
  enqueueCommsIncrementalSweep,
  enqueueCommsSubscriptionsRenew,
} from './queue.js'
import { executeExecutorCommandJob } from './control/executor-commands.js'
import { EXECUTOR_COMMAND_TOPIC } from './run/executor-toolset.js'
import { handleCallRingTimeout, sweepExpiredActiveCalls } from './control/call-lifecycle.js'
import { handleCallRingCancel, handleCallRingDispatch } from './control/call-ring-dispatch.js'

const config = loadConfig()
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = config.database.url
}
const databaseUrl = process.env.DATABASE_URL

const prisma = getPrismaClient({
  connectionLimit: config.database.poolMax,
  log: config.mode === 'local' ? ['warn', 'error'] : ['error'],
})

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

  // Queue provider is config-switchable (prereq #12)
  let queueProvider: PgQueueProvider
  if (config.queue.provider === 'pubsub') {
    console.warn('[worker] Pub/Sub queue provider configured but not yet available — using PgQueueProvider')
  }
  queueProvider = new PgQueueProvider(pool)
  const realtimeTransport = new PgRealtimeTransport(pool, databaseUrl)
  // Same chokepoint the api builds (api/src/index.ts) — the worker only ever
  // reads bytes back out (knowledge.extract), it never stores/deletes, but the
  // guardrail is "route all blob file work through FileService", not "only
  // where writes happen".
  const fileService = createFileService({
    prisma,
    storage: getStorage(config.storage),
    maxUploadBytes: config.storage.maxUploadBytes,
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
  }
  setCloudBrowserReleaseHook(async (runId) => {
    await releaseSessionsForRun(cloudBrowser, { runId, releasedBy: 'run_terminal' })
  })

  const abortController = new AbortController()
  const runnerLabelPrefix = `${process.env.HOSTNAME ?? 'local-worker'}`

  queueProvider.subscribe(
    'call.ring-timeout',
    async (job) => {
      const payload = job.payload as { callId?: unknown }
      if (typeof payload.callId !== 'string') return
      await handleCallRingTimeout(prisma, realtimeTransport, payload.callId)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'run.execute',
    async (job) => {
      const payload = RunExecuteJobPayloadSchema.parse(job.payload)
      await executeRunJob(
        {
          cloudBrowser,
          deepSignalMcpIdentity,
          executorCommandEncryptionSecret: config.auth.secret ?? undefined,
          ledgerIdentity,
          mcpSecrets,
          modelClient,
          prisma,
          queueProvider,
          realtimeTransport,
          searchConfig: {
            modelClient,
            pool,
          },
          subscriptionSecrets,
        },
        payload,
        { attempt: job.attempt, maxAttempts: job.maxAttempts },
      )
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    EXECUTOR_COMMAND_TOPIC,
    async (job) => {
      await executeExecutorCommandJob(prisma, config.auth.secret ?? '', job.payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'orchestrate.decide',
    async (job) => {
      const payload = OrchestrateDecideJobPayloadSchema.parse(job.payload)
      await executeOrchestrateDecideJob(
        { modelClient, prisma, realtimeTransport },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  const webPush = config.webPush
  let webPushCreds = webPush.publicKey && webPush.privateKey && webPush.subject
    ? {
      publicKey: webPush.publicKey,
      privateKey: webPush.privateKey,
      subject: webPush.subject,
    }
    : undefined
  if (webPushCreds) {
    // Fail fast at startup, not per-notification: validate the subject + key
    // material once. If it's malformed, disable web push with a clear warning
    // rather than logging an error on every subscription forever.
    try {
      assertValidVapidSubject(webPushCreds.subject)
      loadVapidPrivateKey(webPushCreds)
    } catch (error) {
      console.warn(
        '[worker] Web Push disabled — invalid VAPID configuration:',
        error instanceof Error ? error.message : String(error),
      )
      webPushCreds = undefined
    }
  }

  queueProvider.subscribe(
    'call.ring-dispatch',
    async (job) => {
      const payload = CallRingDispatchJobPayloadSchema.parse(job.payload)
      await handleCallRingDispatch({
        authSecret: config.auth.secret ?? '',
        prisma,
        ...(webPushCreds ? { webPush: webPushCreds } : {}),
      }, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'call.ring-cancel',
    async (job) => {
      const payload = CallRingCancelJobPayloadSchema.parse(job.payload)
      await handleCallRingCancel({
        authSecret: config.auth.secret ?? '',
        prisma,
        ...(webPushCreds ? { webPush: webPushCreds } : {}),
      }, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'attention.dispatch',
    async (job) => {
      const payload = AttentionDispatchJobPayloadSchema.parse(job.payload)
      await handleAttentionDispatch(
        {
          prisma,
          authSecret: config.auth.secret ?? '',
          ...(webPushCreds ? { webPush: webPushCreds } : {}),
        },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'push.dispatch',
    async (job) => {
      const payload = PushDispatchJobPayloadSchema.parse(job.payload)
      await handlePushDispatch(
        {
          prisma,
          authSecret: config.auth.secret ?? '',
          ...(webPushCreds ? { webPush: webPushCreds } : {}),
        },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'budget.alert-dispatch',
    async (job) => {
      const payload = BudgetAlertDispatchJobPayloadSchema.parse(job.payload)
      await handleBudgetAlertDispatch(
        {
          prisma,
          authSecret: config.auth.secret ?? '',
          ...(webPushCreds ? { webPush: webPushCreds } : {}),
        },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'trigger.health-alert',
    async (job) => {
      const payload = TriggerHealthAlertJobPayloadSchema.parse(job.payload)
      await handleTriggerHealthAlert(
        {
          prisma,
          authSecret: config.auth.secret ?? '',
          ...(webPushCreds ? { webPush: webPushCreds } : {}),
        },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'workflow.run.failure-dispatch',
    async (job) => {
      const payload = WorkflowRunFailureDispatchJobPayloadSchema.parse(job.payload)
      await handleWorkflowRunFailureDispatch(
        {
          prisma,
          authSecret: config.auth.secret ?? '',
          ...(webPushCreds ? { webPush: webPushCreds } : {}),
        },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    MEMORY_CONSOLIDATION_TOPIC,
    async (job) => {
      await executeRunMemoryConsolidationJob(
        {
          captureConfig: {
            modelClient,
            pool,
          },
        },
        job.payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    KNOWLEDGE_EMBED_TOPIC,
    async (job) => {
      const payload = KnowledgeEmbedJobPayloadSchema.parse(job.payload)
      await executeKnowledgeEmbedJob({ modelClient, prisma }, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    KNOWLEDGE_EXTRACT_TOPIC,
    async (job) => {
      const payload = KnowledgeExtractJobPayloadSchema.parse(job.payload)
      await executeKnowledgeExtractJob({ fileService, prisma }, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    ATTACHMENT_THUMBNAIL_TOPIC,
    async (job) => {
      const payload = AttachmentThumbnailJobPayloadSchema.parse(job.payload)
      await executeAttachmentThumbnailJob({ fileService, prisma }, payload)
    },
    { signal: abortController.signal },
  )

  // Automatic team access after sign-in
  // (docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md).
  // The instance flag reaches every handler and the sweep, so switching it off
  // stops provisioning on rules that already exist — the routes alone cannot,
  // because they 404 when it is off and take the emergency stop with them.
  const automaticMembershipEnabled = config.automaticMembership.enabled
  queueProvider.subscribe(
    AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
    async (job) => {
      const payload = AutomaticMembershipProvisionJobPayloadSchema.parse(job.payload)
      await executeAutomaticMembershipProvisionJob(
        { enabled: automaticMembershipEnabled, prisma },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
    async (job) => {
      const payload = AutomaticMembershipReconcileJobPayloadSchema.parse(job.payload)
      await executeAutomaticMembershipReconcileJob(
        { enabled: automaticMembershipEnabled, prisma },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    AUTOMATIC_MEMBERSHIP_REVALIDATE_TOPIC,
    async (job) => {
      const payload = AutomaticMembershipRevalidateJobPayloadSchema.parse(job.payload)
      await executeAutomaticMembershipRevalidateJob(
        { enabled: automaticMembershipEnabled, prisma },
        payload,
      )
    },
    { signal: abortController.signal },
  )

  // Dashboards: one cache per source, refreshed here and nowhere else, so
  // viewing a dashboard never causes an outbound request.
  const dashboardEgressPolicy = {
    deniedOrigins: [config.api.publicUrl].filter((value): value is string => Boolean(value)),
  }
  const dashboardSecretResolver = createMcpSecretResolver(prisma, config.auth.secret ?? '')
  const dashboardRefreshDeps = {
    prisma,
    fileService,
    egressPolicy: dashboardEgressPolicy,
    resolveCredential: async (ref: string) =>
      ref.startsWith('secret_dashboard_') ? dashboardSecretResolver.resolve(ref) : null,
    realtimeTransport,
  }

  queueProvider.subscribe(
    DASHBOARD_REFRESH_TOPIC,
    async (job) => {
      const payload = job.payload as { sourceId?: unknown }
      if (typeof payload?.sourceId !== 'string') return
      await refreshDashboardDataSource(dashboardRefreshDeps, { sourceId: payload.sourceId })
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'trigger.event.dispatch',
    async (job) => {
      const payload = TriggerEventDispatchJobPayloadSchema.parse(job.payload)
      await dispatchEventTriggers(prisma, payload)
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    'workflow.run.execute',
    async (job) => {
      const payload = WorkflowRunExecuteJobPayloadSchema.parse(job.payload)
      await executeWorkflowRun({
        actorContext: payload.actorContext,
        ledgerIdentity,
        prisma,
        workflowRunId: payload.workflowRunId,
      })
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    DEMONSTRATION_GENERALIZE_TOPIC,
    async (job) => {
      const payload = DemonstrationGeneralizeJobPayloadSchema.parse(job.payload)
      await generalizeDemonstration(prisma, payload, undefined, ledgerIdentity)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    'execution.environment.allocate',
    async (job) => {
      const payload = ExecutionEnvironmentAllocateJobPayloadSchema.parse(job.payload)
      await allocateExecutionEnvironmentInstance(prisma, {
        instanceId: payload.instanceId,
        runnerLabelPrefix,
      })
    },
    {
      signal: abortController.signal,
    },
  )

  queueProvider.subscribe(
    'execution.environment.terminate',
    async (job) => {
      const payload = ExecutionEnvironmentTerminateJobPayloadSchema.parse(job.payload)
      await terminateExecutionEnvironmentInstance(prisma, payload.instanceId)
    },
    {
      signal: abortController.signal,
    },
  )

  // Individual Communications Connector sync pipeline. Provider adapters plug
  // into the shared @nessie/comms-connect registry later; these handlers load a
  // connection, resolve its connector (typed error when none is registered),
  // run the sync phase, and persist normalized events idempotently.
  const commsSyncDeps = {
    prisma,
    encryptionSecret: config.auth.secret ?? '',
  }

  // Register the communications connector adapters into the shared registry so
  // sync/renewal jobs can resolve a connector; unset providers stay unregistered
  // and their jobs park cleanly on ConnectorNotRegisteredError.
  const commsProviders = registerCommsConnectorsFromEnv(process.env)
  console.log(
    `[worker] comms connectors registered: ${
      commsProviders.length > 0 ? commsProviders.join(', ') : 'none'
    }`,
  )

  // Board sources. Unset providers stay unregistered: their connect option is
  // never offered and their jobs park with a reason, rather than failing in a
  // way that reads like an outage.
  const boardProviders = registerBoardSourceAdaptersFromEnv(process.env)
  console.log(
    `[worker] board-source adapters registered: ${
      boardProviders.length > 0 ? boardProviders.join(', ') : 'none'
    }`,
  )

  const boardSourceDeps = {
    prisma,
    encryptionSecret: config.auth.secret ?? '',
    publicApiUrl: config.api.publicUrl ?? null,
    enqueueHealthAlert: async (payload: { sourceId: string; revision: number }) => {
      await enqueueBoardSourceHealthAlert(prisma, payload)
    },
    publishBoardUpdated: async (input: { organizationId: string; projectId: string }) => {
      if (!realtimeTransport) return
      const scope = {
        kind: 'organization' as const,
        organizationId: parseOrganizationId(input.organizationId),
      }
      await realtimeTransport
        .publishWs([scope], {
          event: 'board.updated',
          data: { projectId: input.projectId },
        })
        .catch(() => undefined)
    },
  }

  for (const topic of [BOARD_SOURCE_SYNC_INITIAL_TOPIC, BOARD_SOURCE_SYNC_INCREMENTAL_TOPIC]) {
    queueProvider.subscribe(
      topic,
      async (job) => {
        const payload = BoardSourceSyncJobPayloadSchema.parse(job.payload)
        await executeBoardSourceSync(boardSourceDeps, payload)
      },
      { signal: abortController.signal },
    )
  }

  queueProvider.subscribe(
    BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
    async (job) => {
      const payload = BoardSourceWebhookJobPayloadSchema.parse(job.payload)
      await processBoardSourceWebhook(boardSourceDeps, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    BOARD_SOURCE_HEALTH_ALERT_TOPIC,
    async (job) => {
      const payload = BoardSourceHealthAlertJobPayloadSchema.parse(job.payload)
      await writeHealthAlerts(prisma, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    COMMS_SYNC_INITIAL_TOPIC,
    async (job) => {
      const payload = CommsSyncInitialJobPayloadSchema.parse(job.payload)
      await executeCommsInitialSyncJob(commsSyncDeps, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    COMMS_SYNC_INCREMENTAL_TOPIC,
    async (job) => {
      const payload = CommsSyncIncrementalJobPayloadSchema.parse(job.payload)
      await executeCommsIncrementalSyncJob(commsSyncDeps, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC,
    async (job) => {
      const payload = CommsIncrementalSweepJobPayloadSchema.parse(job.payload)
      await executeCommsIncrementalSweepJob(commsSyncDeps, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
    async (job) => {
      const payload = CommsSubscriptionsRenewJobPayloadSchema.parse(job.payload)
      await renewCommsSubscriptions(commsSyncDeps, payload)
    },
    { signal: abortController.signal },
  )

  queueProvider.subscribe(
    COMMS_WEBHOOK_PROCESS_TOPIC,
    async (job) => {
      const payload = CommsWebhookProcessJobPayloadSchema.parse(job.payload)
      await processCommsWebhookJob({ prisma }, payload)
    },
    { signal: abortController.signal },
  )

  // Hosted agent mail. The three handlers register only when the deployment is
  // configured for it: an unconfigured instance parks nothing and claims
  // nothing, and the public inbound route already answers 503 in that state.
  const agentMailReadiness = resolveAgentMailReadiness(config.email)
  if (agentMailReadiness.ready) {
    const agentEmailDeps: AgentEmailJobDeps = {
      config: agentMailReadiness.config,
      files: fileService,
      prisma,
      realtimeTransport,
      transport: createAgentMailTransport(agentMailReadiness.config),
    }

    queueProvider.subscribe(
      AGENT_EMAIL_INBOUND_TOPIC,
      async (job) => {
        const payload = AgentEmailInboundJobPayloadSchema.parse(job.payload)
        await processAgentEmailInboundJob(agentEmailDeps, payload)
      },
      { signal: abortController.signal },
    )

    queueProvider.subscribe(
      AGENT_EMAIL_SEND_TOPIC,
      async (job) => {
        const payload = AgentEmailSendJobPayloadSchema.parse(job.payload)
        await processAgentEmailSendJob(agentEmailDeps, payload)
      },
      { signal: abortController.signal },
    )

    queueProvider.subscribe(
      AGENT_EMAIL_RETENTION_TOPIC,
      async (job) => {
        const payload = AgentEmailRetentionJobPayloadSchema.parse(job.payload)
        await processAgentEmailRetentionJob(agentEmailDeps, payload)
      },
      { signal: abortController.signal },
    )
  } else {
    console.info('[worker.agent-email] disabled', { missing: agentMailReadiness.missing })
  }

  await registerExecutionRunners(prisma, {
    labelPrefix: runnerLabelPrefix,
  })

  let triggerSweepInFlight = false
  const triggerSweepInterval = setInterval(async () => {
    if (triggerSweepInFlight || abortController.signal.aborted) {
      return
    }

    triggerSweepInFlight = true
    try {
      await sweepDueScheduledTriggers(prisma, {
        limit: 20,
      })
    } catch (error) {
      console.error('[worker.trigger-sweep] failed', error)
    } finally {
      triggerSweepInFlight = false
    }
  }, 15_000)

  // The undo window only means anything if something eventually dispatches the
  // held send. 5s so the wait a person sees is close to the window they were
  // promised, not the window plus a sweep tick.
  let gmailSendSweepInFlight = false
  const gmailSendSweepInterval = setInterval(async () => {
    if (gmailSendSweepInFlight || abortController.signal.aborted) return
    const encryptionSecret = process.env.NESSIE_AUTH_SECRET
    if (!encryptionSecret) return
    gmailSendSweepInFlight = true
    try {
      await sweepDueGmailSends(prisma, { encryptionSecret })
    } catch (error) {
      console.error('[worker.gmail-send-sweep] failed', error)
    } finally {
      gmailSendSweepInFlight = false
    }
  }, 5_000)

  const maxActiveCallHours = (() => {
    const configured = Number(process.env.NESSIE_CALL_MAX_ACTIVE_HOURS)
    return Number.isFinite(configured) && configured > 0 ? configured : 8
  })()
  let activeCallExpiryInFlight = false
  const activeCallExpiryInterval = setInterval(async () => {
    if (activeCallExpiryInFlight || abortController.signal.aborted) return
    activeCallExpiryInFlight = true
    try {
      await sweepExpiredActiveCalls(
        prisma,
        realtimeTransport,
        new Date(Date.now() - maxActiveCallHours * 60 * 60 * 1000),
      )
    } catch (error) {
      console.error('[worker.call-expiry] failed', error)
    } finally {
      activeCallExpiryInFlight = false
    }
  }, 60_000)

  // Due-source sweep. Reuses the trigger poller's claim shape rather than
  // introducing a second scheduler: a conditional update on `claimedAt` means
  // two workers cannot both take one source.
  let dashboardSweepInFlight = false
  const dashboardSweepInterval = setInterval(async () => {
    if (dashboardSweepInFlight || abortController.signal.aborted) return
    dashboardSweepInFlight = true
    try {
      const claimed = await sweepDueDashboardSources(prisma, { limit: 20 })
      for (const source of claimed) {
        // One queued attempt per source: a slow fetch must not pile up.
        await queueProvider.enqueue(
          DASHBOARD_REFRESH_TOPIC,
          { sourceId: source.sourceId },
          { idempotencyKey: `dashboard:refresh:${source.sourceId}` },
        )
      }
    } catch (error) {
      console.error('[worker.dashboard-sweep] failed', error)
    } finally {
      dashboardSweepInFlight = false
    }
  }, 30_000)

  // Board-source sweep. The same claim shape as the dashboard sweep above, for
  // the same reason: a conditional update on `claimedAt` is what stops two
  // workers syncing one source at once.
  let boardSourceSweepInFlight = false
  const boardSourceSweepInterval = setInterval(async () => {
    if (boardSourceSweepInFlight || abortController.signal.aborted) return
    boardSourceSweepInFlight = true
    try {
      const claimed = await sweepDueBoardSources(prisma, { limit: 20 })
      for (const source of claimed) {
        await enqueueBoardSourceSync(prisma, { sourceId: source.sourceId })
      }
    } catch (error) {
      console.error('[worker.board-source-sweep] failed', error)
    } finally {
      boardSourceSweepInFlight = false
    }
  }, 30_000)

  // Automatic-membership DNS revalidation. A short tick that asks "is one
  // due?", not a 24-hour timer: a long interval never fires in a deployment
  // that redeploys more often than its period, and this is the control that
  // catches a domain leaving the organisation's hands.
  let domainRevalidationSweepInFlight = false
  const domainRevalidationInterval = setInterval(async () => {
    if (domainRevalidationSweepInFlight || abortController.signal.aborted) return
    domainRevalidationSweepInFlight = true
    try {
      await sweepDueDomainRevalidations(prisma, automaticMembershipEnabled)
      await sweepStrandedReconciliations(prisma, automaticMembershipEnabled)
    } catch (error) {
      console.error('[worker.automatic-membership-revalidation] failed', error)
    } finally {
      domainRevalidationSweepInFlight = false
    }
  }, REVALIDATION_SWEEP_INTERVAL_MS)

  // W6: reclaim stuck workflow steps — an expired lease (actively-worked step
  // whose worker died) or an expired deadline (suspended step waiting on an
  // external continuation). Both conditions; a lease-only sweep never reclaims
  // the likeliest hangs.
  let workflowStepReapInFlight = false
  const workflowStepReapInterval = setInterval(async () => {
    if (workflowStepReapInFlight || abortController.signal.aborted) {
      return
    }

    workflowStepReapInFlight = true
    try {
      await reapStuckWorkflowSteps(prisma, { limit: 20 })
    } catch (error) {
      console.error('[worker.workflow-step-reaper] failed', error)
    } finally {
      workflowStepReapInFlight = false
    }
  }, 15_000)

  // A run that crashed before any terminal transition, or a session that
  // outlived its TTL, still costs browser-hours until somebody tells
  // Browserbase to stop it. Reaping calls the provider; flipping the row alone
  // would leave a browser billing with nothing pointing at it.
  let cloudBrowserReapInFlight = false
  const cloudBrowserReapInterval = setInterval(async () => {
    if (cloudBrowserReapInFlight || abortController.signal.aborted) {
      return
    }

    cloudBrowserReapInFlight = true
    try {
      await reapExpiredCloudBrowserSessions(cloudBrowser, { limit: 20 })
      // A claim nobody refreshed must stop blocking the agent, and a
      // tombstoned browser's context must actually be deleted at Browserbase
      // rather than left behind holding somebody's login state.
      await expireStaleControlClaims(prisma)
      await reconcileTombstonedAgentBrowsers(cloudBrowser, { limit: 10 })
    } catch (error) {
      console.error('[worker.cloud-browser-reaper] failed', error)
    } finally {
      cloudBrowserReapInFlight = false
    }
  }, 30_000)

  // sp-webhook: re-attempt failed trigger deliveries that are due for retry.
  let deliveryRetryInFlight = false
  const deliveryRetryInterval = setInterval(async () => {
    if (deliveryRetryInFlight || abortController.signal.aborted) {
      return
    }

    deliveryRetryInFlight = true
    try {
      await retryFailedTriggerDeliveries(prisma, reattemptTriggerDelivery, {
        limit: 10,
      })
    } catch (error) {
      console.error('[worker.trigger-retry] failed', error)
    } finally {
      deliveryRetryInFlight = false
    }
  }, 15_000)

  let mailboxSweepInFlight = false
  const mailboxSweepInterval = setInterval(async () => {
    if (mailboxSweepInFlight || abortController.signal.aborted) {
      return
    }

    mailboxSweepInFlight = true
    try {
      await reclaimExpiredMailboxMessages(prisma)

      let dispatched = true
      let iterations = 0
      while (dispatched && iterations < 10) {
        dispatched = await dispatchNextMailboxMessage(prisma, realtimeTransport)
        iterations += 1
      }
    } catch (error) {
      console.error('[worker.mailbox-sweep] failed', error)
    } finally {
      mailboxSweepInFlight = false
    }
  }, 5_000)

  const runnerHeartbeatInterval = setInterval(async () => {
    if (abortController.signal.aborted) {
      return
    }

    try {
      await registerExecutionRunners(prisma, {
        labelPrefix: runnerLabelPrefix,
      })
      await renewExecutionLeases(prisma, {
        runnerLabelPrefix,
      })
    } catch (error) {
      console.error('[worker.execution-runners] heartbeat failed', error)
    }
  }, 30_000)

  const executionLeaseSweepInterval = setInterval(async () => {
    if (abortController.signal.aborted) {
      return
    }

    try {
      await expireExecutionLeases(prisma)
    } catch (error) {
      console.error('[worker.execution-leases] reconcile failed', error)
    }
  }, 15_000)

  // Re-poll for pended thread messages whose in-flight run vanished without
  // draining (worker crash between terminal update and drain, or an API-side
  // cancel of a queued run): enqueue their batched follow-up run.
  let pendingBatchSweepInFlight = false
  const pendingBatchSweepInterval = setInterval(async () => {
    if (pendingBatchSweepInFlight || abortController.signal.aborted) {
      return
    }

    pendingBatchSweepInFlight = true
    try {
      await sweepPendingThreadMessages(prisma, { limit: 20 })
    } catch (error) {
      console.error('[worker.pending-batch-sweep] failed', error)
    } finally {
      pendingBatchSweepInFlight = false
    }
  }, 10_000)

  // Enqueue the communications subscription-renewal sweep on a fixed cadence.
  // The idempotency key is bucketed to the interval so multiple worker replicas
  // ticking together enqueue at most one sweep per window.
  const COMMS_RENEW_INTERVAL_MS = 5 * 60 * 1000
  const commsRenewInterval = setInterval(async () => {
    if (abortController.signal.aborted) {
      return
    }

    try {
      const bucket = Math.floor(Date.now() / COMMS_RENEW_INTERVAL_MS)
      await enqueueCommsSubscriptionsRenew(
        prisma,
        {},
        `comms-subscriptions-renew:${bucket}`,
      )
    } catch (error) {
      console.error('[worker.comms-renew] enqueue failed', error)
    }
  }, COMMS_RENEW_INTERVAL_MS)

  // Explicit connector opt-in keeps webhook-backed providers out of this
  // reconciliation path; distinct per-provider buckets honour their cadence.
  const COMMS_INCREMENTAL_SWEEP_INTERVAL_MS = 60 * 1000
  const commsIncrementalSweepInterval = setInterval(async () => {
    if (abortController.signal.aborted) return
    try {
      const now = Date.now()
      for (const polling of listIncrementalPollingConnectors()) {
        const bucket = Math.floor(now / polling.intervalMs)
        await enqueueCommsIncrementalSweep(
          prisma,
          { provider: polling.provider, bucket },
          `comms-incremental-sweep:${polling.provider}:${bucket}:start`,
        )
      }
    } catch (error) {
      console.error('[worker.comms-incremental-sweep] enqueue failed', error)
    }
  }, COMMS_INCREMENTAL_SWEEP_INTERVAL_MS)

  // Apps catalogue registry sync. `maybeSyncRegistry` self-gates on the last
  // completed run (6h window, `NESSIE_REGISTRY_SYNC_INTERVAL_MS`), so a restart
  // or a frequent poll never triggers a fresh multi-minute walk — the poll only
  // asks "is one due?". The interval and the post-startup kick share this one
  // guarded body so the kick fills an empty store within a minute of a fresh
  // deploy while the interval keeps it fresh (~every 6h) thereafter.
  let registrySyncSweepInFlight = false
  const runRegistrySyncSweep = async (): Promise<void> => {
    if (registrySyncSweepInFlight || abortController.signal.aborted) {
      return
    }

    registrySyncSweepInFlight = true
    try {
      await maybeSyncRegistry(prisma)
    } catch (error) {
      console.error('[worker.registry-sync] failed', error)
    } finally {
      registrySyncSweepInFlight = false
    }
  }

  // Guard a bad env value: an unparseable NESSIE_REGISTRY_SYNC_SWEEP_MS would
  // otherwise become a NaN delay (a hot 1ms loop), so fall back to 30 minutes.
  const registrySyncSweepMs = (() => {
    const fromEnv = Number(process.env.NESSIE_REGISTRY_SYNC_SWEEP_MS)
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30 * 60 * 1000
  })()
  const registrySyncSweepInterval = setInterval(() => {
    void runRegistrySyncSweep()
  }, registrySyncSweepMs)
  // Fire one sweep shortly after startup so a fresh install fills the store
  // promptly rather than waiting up to a full poll interval; it still goes
  // through `maybeSyncRegistry`, so it no-ops if a sync ran recently.
  const registrySyncKickoff = setTimeout(() => {
    void runRegistrySyncSweep()
  }, 60 * 1000)

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

  const stop = async () => {
    abortController.abort()
    clearInterval(triggerSweepInterval)
    clearInterval(gmailSendSweepInterval)
    clearInterval(activeCallExpiryInterval)
    clearInterval(dashboardSweepInterval)
    clearInterval(boardSourceSweepInterval)
    clearInterval(domainRevalidationInterval)
    clearInterval(workflowStepReapInterval)
    clearInterval(cloudBrowserReapInterval)
    clearInterval(deliveryRetryInterval)
    clearInterval(mailboxSweepInterval)
    clearInterval(runnerHeartbeatInterval)
    clearInterval(executionLeaseSweepInterval)
    clearInterval(pendingBatchSweepInterval)
    clearInterval(commsRenewInterval)
    clearInterval(commsIncrementalSweepInterval)
    clearInterval(registrySyncSweepInterval)
    clearTimeout(registrySyncKickoff)
    modelClient.close()
    await realtimeTransport.close()
    await pool.end()
    await prisma.$disconnect()
  }

  if (standalone) {
    process.once('SIGINT', () => {
      void stop().finally(() => process.exit(0))
    })
    process.once('SIGTERM', () => {
      void stop().finally(() => process.exit(0))
    })
  }

  return { stop }
}

if (isMainModule()) {
  await startWorker({ standalone: true })
}
