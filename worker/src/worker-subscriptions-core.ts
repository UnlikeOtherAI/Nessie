import { assertValidVapidSubject, loadVapidPrivateKey } from '@nessie/push'
import {
  AttachmentThumbnailJobPayloadSchema,
  ATTACHMENT_THUMBNAIL_TOPIC,
  AttentionDispatchJobPayloadSchema,
  AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
  AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
  AUTOMATIC_MEMBERSHIP_REVALIDATE_TOPIC,
  AutomaticMembershipProvisionJobPayloadSchema,
  AutomaticMembershipReconcileJobPayloadSchema,
  AutomaticMembershipRevalidateJobPayloadSchema,
  BUDGET_ALERT_DISPATCH_TOPIC,
  BudgetAlertDispatchJobPayloadSchema,
  CallRingCancelJobPayloadSchema,
  CallRingDispatchJobPayloadSchema,
  DEMONSTRATION_GENERALIZE_TOPIC,
  DemonstrationGeneralizeJobPayloadSchema,
  ExecutionEnvironmentAllocateJobPayloadSchema,
  ExecutionEnvironmentTerminateJobPayloadSchema,
  KNOWLEDGE_EMBED_TOPIC,
  KNOWLEDGE_EXTRACT_TOPIC,
  KnowledgeEmbedJobPayloadSchema,
  KnowledgeExtractJobPayloadSchema,
  OrchestrateDecideJobPayloadSchema,
  PushDispatchJobPayloadSchema,
  RUN_COMPLETION_FOLLOWUP_TOPIC,
  RunCompletionFollowupJobPayloadSchema,
  RunExecuteJobPayloadSchema,
  TriggerEventDispatchJobPayloadSchema,
  TriggerHealthAlertJobPayloadSchema,
  TRIGGER_WEBHOOK_DISPATCH_TOPIC,
  TriggerWebhookDispatchJobPayloadSchema,
  WorkflowRunExecuteJobPayloadSchema,
  WorkflowRunFailureDispatchJobPayloadSchema,
} from '@nessie/schemas'
import { DASHBOARD_REFRESH_TOPIC } from '@nessie/dashboard'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import { refreshDashboardDataSource } from './control/dashboard-refresh.js'
import { runDeepSignalInsightFanout } from './control/deepsignal-insight.js'
import { DEEPSIGNAL_INSIGHT_FANOUT_TOPIC, DeepSignalInsightFanoutJobPayloadSchema } from '@nessie/schemas'
import { MEMORY_CONSOLIDATION_TOPIC } from './run/memory-consolidation.js'
import {
  allocateExecutionEnvironmentInstance,
  terminateExecutionEnvironmentInstance,
} from './control/execution.js'
import { executeAttachmentThumbnailJob } from './control/attachment-thumbnail.js'
import { generalizeDemonstration } from './control/demonstration-generalize.js'
import {
  executeAutomaticMembershipProvisionJob,
} from './control/automatic-membership/provision.js'
import {
  executeAutomaticMembershipReconcileJob,
} from './control/automatic-membership/reconcile.js'
import { executeAutomaticMembershipRevalidateJob } from './control/automatic-membership/revalidate.js'
import { executeKnowledgeEmbedJob } from './control/knowledge-embed.js'
import { executeKnowledgeExtractJob } from './control/knowledge-extract.js'
import { handlePushDispatch } from './control/push-dispatch.js'
import { handleBudgetAlertDispatch } from './control/budget-alert-dispatch.js'
import { handleTriggerHealthAlert } from './control/trigger-health-dispatch.js'
import { handleWorkflowRunFailureDispatch } from './control/workflow-failure-dispatch.js'
import { handleAttentionDispatch } from './control/attention-dispatch.js'
import { dispatchEventTriggers, dispatchWebhookTrigger } from './control/triggers.js'
import { executeWorkflowRun } from './control/workflows.js'
import { executeRunJob } from './run/execute.js'
import { executeRunCompletionFollowup } from './run/execute/completion-followup.js'
import { executeRunMemoryConsolidationJob } from './run/memory-consolidation.js'
import { executeOrchestrateDecideJob } from './run/orchestrate.js'
import { executeExecutorCommandJob } from './control/executor-commands.js'
import { EXECUTOR_COMMAND_TOPIC } from './run/executor-toolset.js'
import { handleCallRingDispatch, handleCallRingCancel } from './control/call-ring-dispatch.js'
import { handleCallRingTimeout } from './control/call-lifecycle.js'
import type { WorkerCoreSubscriptionDeps } from './worker-runtime-types.js'
export const registerWorkerCoreSubscriptions = (deps: WorkerCoreSubscriptionDeps): boolean => {
  const {
    abortSignal,
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
  } = deps
subscribe(
  'call.ring-timeout',
  async (job) => {
    const payload = job.payload as { callId?: unknown }
    if (typeof payload.callId !== 'string') return
    await handleCallRingTimeout(prisma, realtimeTransport, payload.callId)
  },
  { signal: abortSignal },
)
subscribe(
  'run.execute',
  // The per-job signal, not the subscription's: it fires on a drain, on a
  // lost lock, and on an abandon, and it is what lets a 45-minute agentic run
  // reach its crash checkpoint and hand the run back inside the shutdown
  // grace instead of being killed mid-inference.
  async (job, { signal }) => {
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
      { signal },
    )
  },
  {
    signal: abortSignal,
  },
)
subscribe(
  RUN_COMPLETION_FOLLOWUP_TOPIC,
  async (job) => {
    const payload = RunCompletionFollowupJobPayloadSchema.parse(job.payload)
    await executeRunCompletionFollowup(
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
        searchConfig: { modelClient, pool },
        subscriptionSecrets,
      },
      payload,
    )
  },
  { signal: abortSignal },
)
subscribe(
  EXECUTOR_COMMAND_TOPIC,
  async (job) => {
    await executeExecutorCommandJob(prisma, config.auth.secret ?? '', job.payload)
  },
  { signal: abortSignal },
)
subscribe(
  'orchestrate.decide',
  async (job) => {
    const payload = OrchestrateDecideJobPayloadSchema.parse(job.payload)
    await executeOrchestrateDecideJob(
      { modelClient, prisma, realtimeTransport },
      payload,
    )
  },
  { signal: abortSignal },
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
subscribe(
  'call.ring-dispatch',
  async (job) => {
    const payload = CallRingDispatchJobPayloadSchema.parse(job.payload)
    await handleCallRingDispatch({
      authSecret: config.auth.secret ?? '',
      prisma,
      ...(webPushCreds ? { webPush: webPushCreds } : {}),
    }, payload)
  },
  { signal: abortSignal },
)
subscribe(
  'call.ring-cancel',
  async (job) => {
    const payload = CallRingCancelJobPayloadSchema.parse(job.payload)
    await handleCallRingCancel({
      authSecret: config.auth.secret ?? '',
      prisma,
      ...(webPushCreds ? { webPush: webPushCreds } : {}),
    }, payload)
  },
  { signal: abortSignal },
)

subscribe(
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
  { signal: abortSignal },
)

// Every `push.dispatch` enqueue carries a deterministic idempotency key
// (`push:<messageId>` from the API, `push:reply:<runId>` from a run's
// interactive reply), so two enqueues collapse to one job; the handler then
// claims a `push_send_claims` row per endpoint before it calls a provider, so
// a job redelivered by a drain, a lock expiry or a nack skips every endpoint
// whose claim already reads `sent`, and genuinely retries the ones whose
// earlier attempt never reached the provider, because those claims were
// released. The guarantee that gives, and the cases it does not cover, are
// stated once in `control/push-send-claim.ts`; nothing here strengthens it.
// `push_deliveries` stays what it was — the post-send outcome log, not the
// guard.
subscribe(
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
  { signal: abortSignal },
)

subscribe(
  BUDGET_ALERT_DISPATCH_TOPIC,
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
  { signal: abortSignal },
)

subscribe(
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
  { signal: abortSignal },
)

subscribe(
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
  { signal: abortSignal },
)

subscribe(
  MEMORY_CONSOLIDATION_TOPIC,
  async (job) => {
    await executeRunMemoryConsolidationJob(
      {
        captureConfig: {
          modelClient,
          pool,
        },
        ledgerIdentity,
        prisma,
      },
      job.payload,
    )
  },
  { signal: abortSignal },
)

subscribe(
  KNOWLEDGE_EMBED_TOPIC,
  async (job) => {
    const payload = KnowledgeEmbedJobPayloadSchema.parse(job.payload)
    await executeKnowledgeEmbedJob({ modelClient, prisma }, payload)
  },
  { signal: abortSignal },
)
subscribe(
  KNOWLEDGE_EXTRACT_TOPIC,
  async (job) => {
    const payload = KnowledgeExtractJobPayloadSchema.parse(job.payload)
    await executeKnowledgeExtractJob({ fileService, modelClient, prisma }, payload)
  },
  { signal: abortSignal },
)
subscribe(
  ATTACHMENT_THUMBNAIL_TOPIC,
  async (job) => {
    const payload = AttachmentThumbnailJobPayloadSchema.parse(job.payload)
    await executeAttachmentThumbnailJob({ fileService, prisma }, payload)
  },
  { signal: abortSignal },
)
// Automatic team access after sign-in
// (docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md).
// The instance flag reaches every handler and the sweep, so switching it off
// stops provisioning on rules that already exist — the routes alone cannot,
// because they 404 when it is off and take the emergency stop with them.
const automaticMembershipEnabled = config.automaticMembership.enabled
subscribe(
  AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
  async (job) => {
    const payload = AutomaticMembershipProvisionJobPayloadSchema.parse(job.payload)
    await executeAutomaticMembershipProvisionJob(
      { enabled: automaticMembershipEnabled, prisma },
      payload,
    )
  },
  { signal: abortSignal },
)
subscribe(
  AUTOMATIC_MEMBERSHIP_RECONCILE_TOPIC,
  async (job) => {
    const payload = AutomaticMembershipReconcileJobPayloadSchema.parse(job.payload)
    await executeAutomaticMembershipReconcileJob(
      { enabled: automaticMembershipEnabled, prisma },
      payload,
    )
  },
  { signal: abortSignal },
)
subscribe(
  AUTOMATIC_MEMBERSHIP_REVALIDATE_TOPIC,
  async (job) => {
    const payload = AutomaticMembershipRevalidateJobPayloadSchema.parse(job.payload)
    await executeAutomaticMembershipRevalidateJob(
      { enabled: automaticMembershipEnabled, prisma },
      payload,
    )
  },
  { signal: abortSignal },
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
subscribe(
  DASHBOARD_REFRESH_TOPIC,
  async (job) => {
    const payload = job.payload as { sourceId?: unknown }
    if (typeof payload?.sourceId !== 'string') return
    await refreshDashboardDataSource(dashboardRefreshDeps, { sourceId: payload.sourceId })
  },
  { signal: abortSignal },
)
subscribe(
  'trigger.event.dispatch',
  async (job) => {
    const payload = TriggerEventDispatchJobPayloadSchema.parse(job.payload)
    await dispatchEventTriggers(prisma, payload)
  },
  {
    signal: abortSignal,
  },
)
// Inbound webhook deliveries. The intake route verifies and acks; the fire
// happens here, on the same seam the scheduler and event dispatch use
// (docs/standards/horizontal-scaling/overview.md § 3).
subscribe(
  TRIGGER_WEBHOOK_DISPATCH_TOPIC,
  async (job) => {
    const payload = TriggerWebhookDispatchJobPayloadSchema.parse(job.payload)
    await dispatchWebhookTrigger(prisma, payload)
  },
  {
    signal: abortSignal,
  },
)
// DeepSignal proactive insights: the receiver verifies and routes, the
// per-recipient digest fan-out runs here.
subscribe(
  DEEPSIGNAL_INSIGHT_FANOUT_TOPIC,
  async (job) => {
    const payload = DeepSignalInsightFanoutJobPayloadSchema.parse(job.payload)
    await runDeepSignalInsightFanout({ prisma, realtimeTransport }, payload)
  },
  {
    signal: abortSignal,
  },
)
subscribe(
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
    signal: abortSignal,
  },
)
subscribe(
  DEMONSTRATION_GENERALIZE_TOPIC,
  async (job) => {
    const payload = DemonstrationGeneralizeJobPayloadSchema.parse(job.payload)
    await generalizeDemonstration(prisma, payload, undefined, ledgerIdentity)
  },
  { signal: abortSignal },
)
subscribe(
  'execution.environment.allocate',
  async (job) => {
    const payload = ExecutionEnvironmentAllocateJobPayloadSchema.parse(job.payload)
    await allocateExecutionEnvironmentInstance(prisma, {
      instanceId: payload.instanceId,
      runnerLabelPrefix,
    })
  },
  {
    signal: abortSignal,
  },
)
subscribe(
  'execution.environment.terminate',
  async (job) => {
    const payload = ExecutionEnvironmentTerminateJobPayloadSchema.parse(job.payload)
    await terminateExecutionEnvironmentInstance(prisma, payload.instanceId)
  },
  {
    signal: abortSignal,
  },
)
  return automaticMembershipEnabled
}
