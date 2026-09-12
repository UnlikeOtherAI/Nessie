import {
  createAgentMailTransport,
  resolveAgentMailReadiness,
} from '@nessie/agent-mail'
import { registerBoardSourceAdaptersFromEnv } from '@nessie/board-source-providers'
import { registerCommsConnectorsFromEnv } from '@nessie/comms-providers'
import {
  BOARD_SOURCE_HEALTH_ALERT_TOPIC,
  BOARD_SOURCE_SYNC_INCREMENTAL_TOPIC,
  BOARD_SOURCE_SYNC_INITIAL_TOPIC,
  BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
  BOARD_SOURCE_WEBHOOKS_RENEW_TOPIC,
  BoardSourceHealthAlertJobPayloadSchema,
  BoardSourceSyncJobPayloadSchema,
  BoardSourceWebhookJobPayloadSchema,
  BoardSourceWebhooksRenewJobPayloadSchema,
  COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  COMMS_SYNC_INCREMENTAL_TOPIC,
  COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC,
  COMMS_SYNC_INITIAL_TOPIC,
  COMMS_WEBHOOK_PROCESS_TOPIC,
  CommsIncrementalSweepJobPayloadSchema,
  CommsSubscriptionsRenewJobPayloadSchema,
  CommsSyncIncrementalJobPayloadSchema,
  CommsSyncInitialJobPayloadSchema,
  CommsWebhookProcessJobPayloadSchema,
  parseOrganizationId,
  AGENT_EMAIL_INBOUND_TOPIC,
  AGENT_EMAIL_RETENTION_TOPIC,
  AGENT_EMAIL_SEND_TOPIC,
  AgentEmailInboundJobPayloadSchema,
  AgentEmailRetentionJobPayloadSchema,
  AgentEmailSendJobPayloadSchema,
} from '@nessie/schemas'
import {
  executeBoardSourceSync,
} from './control/board-source-sync.js'
import { processBoardSourceWebhook } from './control/board-source-webhook.js'
import { renewBoardSourceWebhooks } from './control/board-source-webhooks-renew.js'
import { writeHealthAlerts } from './control/board-source-health.js'
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
import { enqueueBoardSourceHealthAlert } from './queue.js'
import { registerExecutionRunners } from './control/execution.js'
import type { WorkerIntegrationSubscriptionDeps } from './worker-runtime-types.js'

export const registerWorkerIntegrationSubscriptions = async (
  deps: WorkerIntegrationSubscriptionDeps,
): Promise<void> => {
  const {
    abortSignal,
    config,
    encryptionKeyRing,
    fileService,
    prisma,
    realtimeTransport,
    runnerLabelPrefix,
    subscribe,
  } = deps

// Individual Communications Connector sync pipeline. Provider adapters plug
// into the shared @nessie/comms-connect registry later; these handlers load a
// connection, resolve its connector (typed error when none is registered),
// run the sync phase, and persist normalized events idempotently.
const commsSyncDeps = {
  prisma,
  encryptionSecret: encryptionKeyRing,
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
  encryptionSecret: encryptionKeyRing,
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
  subscribe(
    topic,
    async (job) => {
      const payload = BoardSourceSyncJobPayloadSchema.parse(job.payload)
      await executeBoardSourceSync(boardSourceDeps, payload)
    },
    { signal: abortSignal },
  )
}

subscribe(
  BOARD_SOURCE_WEBHOOK_PROCESS_TOPIC,
  async (job) => {
    const payload = BoardSourceWebhookJobPayloadSchema.parse(job.payload)
    await processBoardSourceWebhook(boardSourceDeps, payload)
  },
  { signal: abortSignal },
)

subscribe(
  BOARD_SOURCE_WEBHOOKS_RENEW_TOPIC,
  async (job) => {
    const payload = BoardSourceWebhooksRenewJobPayloadSchema.parse(job.payload)
    await renewBoardSourceWebhooks(boardSourceDeps, payload)
  },
  { signal: abortSignal },
)

subscribe(
  BOARD_SOURCE_HEALTH_ALERT_TOPIC,
  async (job) => {
    const payload = BoardSourceHealthAlertJobPayloadSchema.parse(job.payload)
    await writeHealthAlerts(prisma, payload)
  },
  { signal: abortSignal },
)

subscribe(
  COMMS_SYNC_INITIAL_TOPIC,
  async (job) => {
    const payload = CommsSyncInitialJobPayloadSchema.parse(job.payload)
    await executeCommsInitialSyncJob(commsSyncDeps, payload)
  },
  { signal: abortSignal },
)

subscribe(
  COMMS_SYNC_INCREMENTAL_TOPIC,
  async (job) => {
    const payload = CommsSyncIncrementalJobPayloadSchema.parse(job.payload)
    await executeCommsIncrementalSyncJob(commsSyncDeps, payload)
  },
  { signal: abortSignal },
)

subscribe(
  COMMS_SYNC_INCREMENTAL_SWEEP_TOPIC,
  async (job) => {
    const payload = CommsIncrementalSweepJobPayloadSchema.parse(job.payload)
    await executeCommsIncrementalSweepJob(commsSyncDeps, payload)
  },
  { signal: abortSignal },
)

subscribe(
  COMMS_SUBSCRIPTIONS_RENEW_TOPIC,
  async (job) => {
    const payload = CommsSubscriptionsRenewJobPayloadSchema.parse(job.payload)
    await renewCommsSubscriptions(commsSyncDeps, payload)
  },
  { signal: abortSignal },
)

subscribe(
  COMMS_WEBHOOK_PROCESS_TOPIC,
  async (job) => {
    const payload = CommsWebhookProcessJobPayloadSchema.parse(job.payload)
    await processCommsWebhookJob({ prisma }, payload)
  },
  { signal: abortSignal },
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

  subscribe(
    AGENT_EMAIL_INBOUND_TOPIC,
    async (job) => {
      const payload = AgentEmailInboundJobPayloadSchema.parse(job.payload)
      await processAgentEmailInboundJob(agentEmailDeps, payload)
    },
    { signal: abortSignal },
  )

  subscribe(
    AGENT_EMAIL_SEND_TOPIC,
    async (job) => {
      const payload = AgentEmailSendJobPayloadSchema.parse(job.payload)
      await processAgentEmailSendJob(agentEmailDeps, payload)
    },
    { signal: abortSignal },
  )

  subscribe(
    AGENT_EMAIL_RETENTION_TOPIC,
    async (job) => {
      const payload = AgentEmailRetentionJobPayloadSchema.parse(job.payload)
      await processAgentEmailRetentionJob(agentEmailDeps, payload)
    },
    { signal: abortSignal },
  )
} else {
  console.info('[worker.agent-email] disabled', { missing: agentMailReadiness.missing })
}

await registerExecutionRunners(prisma, {
  labelPrefix: runnerLabelPrefix,
})
}
