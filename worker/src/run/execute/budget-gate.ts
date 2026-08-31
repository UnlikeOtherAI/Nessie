import { evaluateBudget } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { maybeEmitBudgetAlerts } from './budget-alert.js'
import { buildScopes } from './scopes.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus, applyRunReplyBookkeeping } from './lifecycle.js'
import { publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import { drainPendingThreadMessagesBestEffort } from '../thread-serialization.js'
import type { BudgetModelOverride, ExecutionDependencies, RunContext } from './types.js'
import { createAgentMessage } from './agent-message.js'
import { enqueueInteractiveReplyPush } from './reply-push.js'

type BudgetBlockOptions = {
  beforeBlockedRunTerminalization?: () => Promise<void>
}

export const terminalizeBudgetBlockedRun = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  reason: string,
  options: BudgetBlockOptions,
): Promise<void> => {
  await options.beforeBlockedRunTerminalization?.()
  const notice = `⚠️ ${reason} — this request was not run.`
  // Fixed server-authored text that predates retrieval, so its basis is always
  // empty — routed through the chokepoint for uniformity, so no post path can
  // drift out of stamping later.
  const blockMessage = await createAgentMessage(deps.prisma, context, {
    agentId: context.agent.id,
    content: notice,
    role: 'assistant',
    threadId: context.run.threadId,
    ...(context.replyRootMessageId
      ? { rootMessageId: context.replyRootMessageId }
      : {}),
  })
  const reply = await applyRunReplyBookkeeping(
    deps.prisma,
    context,
    blockMessage.createdAt,
  )
  await publishMessageCreated(deps.realtimeTransport, context, {
    content: blockMessage.content,
    messageId: blockMessage.id,
    role: blockMessage.role,
    ...(reply ? { reply } : {}),
  })
  const replyPushMessage = {
    content: blockMessage.content,
    contentVisibility: blockMessage.basis.length > 0 ? 'generic' as const : 'full' as const,
    id: blockMessage.id,
  }
  await updateRunStatus(deps.prisma, context.run.id, 'failed')
  await updateTaskStatus(deps.prisma, context.task.id, 'failed')
  await setAgentStatus(deps.prisma, context.agent.id, 'idle')
  await publishRunUpdated(deps.realtimeTransport, context, 'failed')
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'failed',
  )
  // The blocked run never claimed the model but still held the (agent,
  // thread) slot: release any pended messages as one batched follow-up.
  await drainPendingThreadMessagesBestEffort(deps.prisma, {
    agentId: context.agent.id,
    ...(context.run.principalUserId ? { principalUserId: context.run.principalUserId } : {}),
    threadId: context.run.threadId,
  })
  await enqueueInteractiveReplyPush(deps, payload, context, replyPushMessage)
  console.warn(`[worker] run ${context.run.id} blocked by budget: ${reason}`)
}

export const applyBudgetGate = async (
  deps: ExecutionDependencies,
  context: RunContext,
  payload: RunExecuteJobPayload,
  options: BudgetBlockOptions = {},
): Promise<
  | { blocked: true }
  | { blocked: false; modelOverride: BudgetModelOverride | null }
> => {
  // Budget gate: refuse to spend on a model when the org is over its monthly cap.
  // Only a live human conversational turn (payload.interactive) is exempt by
  // default; automations — triggers (even manually fired), subtasks, mailbox,
  // scheduled runs — leave interactive unset and are throttled.
  const evaluation = await evaluateBudget(
    deps.prisma,
    {
      organizationId: payload.actorContext.tenant.organizationId,
      projectId: payload.actorContext.tenant.projectId,
      teamId: payload.actorContext.tenant.teamId,
    },
    { isHuman: payload.interactive === true },
  )
  const budgetDecision = evaluation.decision
  // When over a degrade budget, run on the cheaper model instead of the agent's.
  const budgetModelOverride =
    budgetDecision.action === 'degrade'
      ? { model: budgetDecision.model, provider: budgetDecision.provider }
      : null
  if (budgetModelOverride) {
    console.warn(
      `[worker] run ${context.run.id} degraded by budget to ${budgetModelOverride.provider}/${budgetModelOverride.model}`,
    )
  }
  if (budgetDecision.action === 'block') {
    await terminalizeBudgetBlockedRun(deps, payload, context, budgetDecision.reason, options)
    // Alerting runs AFTER the verdict is fully applied and never throws, so the
    // blocking behaviour is byte-identical whether or not an alert fires.
    await maybeEmitBudgetAlerts(deps, context, evaluation)
    return { blocked: true }
  }

  // Observe a threshold crossing without touching the allow/degrade verdict.
  await maybeEmitBudgetAlerts(deps, context, evaluation)
  return { blocked: false, modelOverride: budgetModelOverride }
}

// The gate only ran pre-run, so a long run could spend far past the cap it was
// admitted under. This probe re-applies the SAME verdict logic (including the
// human-interactive exemption) between iterations, throttled to at most one
// evaluation per interval so a long run adds a handful of cheap reads.
//
// A block is sticky and fires the existing 'blocked' alert dedupe machinery
// once; the loop then stops via the classified-stop path (checkpoint + notice).
// Probe failures are swallowed: budget telemetry must never crash a run.
const BUDGET_RECHECK_INTERVAL_MS = 30_000

export const createBudgetBlockedProbe = (
  deps: ExecutionDependencies,
  context: RunContext,
  payload: RunExecuteJobPayload,
): (() => Promise<boolean>) => {
  // The pre-run gate just evaluated; start the throttle window from now.
  let lastEvaluatedAt = Date.now()
  let blocked = false

  return async () => {
    if (blocked) return true
    if (Date.now() - lastEvaluatedAt < BUDGET_RECHECK_INTERVAL_MS) return false
    lastEvaluatedAt = Date.now()
    try {
      const evaluation = await evaluateBudget(
        deps.prisma,
        {
          organizationId: payload.actorContext.tenant.organizationId,
          projectId: payload.actorContext.tenant.projectId,
          teamId: payload.actorContext.tenant.teamId,
        },
        { isHuman: payload.interactive === true },
      )
      if (evaluation.decision.action !== 'block') return false
      blocked = true
      await maybeEmitBudgetAlerts(deps, context, evaluation)
      console.warn(
        `[worker] run ${context.run.id} paused mid-run by budget: ${evaluation.decision.reason}`,
      )
      return true
    } catch (error) {
      console.error('[worker] mid-run budget recheck failed for run', context.run.id, error)
      return false
    }
  }
}
