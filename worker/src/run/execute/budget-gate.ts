import { admitRunToBudget, type BudgetReservationEstimate, evaluateBudget } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { maybeEmitBudgetAlerts } from './budget-alert.js'
import { resolveRunBackstop } from '../run-budget.js'
import { buildScopes } from './scopes.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus, applyRunReplyBookkeeping } from './lifecycle.js'
import { publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import { drainPendingThreadMessagesBestEffort } from '../thread-serialization.js'
import type { BudgetModelOverride, ExecutionDependencies, RunContext } from './types.js'
import { createAgentMessage } from './agent-message.js'
import { enqueueInteractiveReplyPush } from './reply-push.js'

type BudgetBlockOptions = {
  beforeBlockedRunTerminalization?: () => Promise<void>
  /**
   * True when this run spends the agent owner's personal subscription.
   *
   * The organization budget then does not apply, in either direction. Blocking
   * would refuse a run the organization is not paying for — with "buy more
   * credits" copy that names the wrong purse — and a `degrade` verdict would
   * silently rewrite the run onto the organization's cheaper Ledger provider,
   * moving the spend it was meant to cap. The per-run backstop envelope
   * (Agent.runLimits / NESSIE_RUN_BACKSTOP_*) still applies in full.
   */
  subscriptionPinned?: boolean
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

/**
 * What this run is assumed capable of spending, for the admission reservation.
 *
 * The run's own ceiling is the only honest estimate available before it starts:
 * `Agent.runLimits` when the designer set one, else the deployment backstop
 * (`NESSIE_RUN_BACKSTOP_MAX_COST_CENTS` / `_MAX_TOKENS`, defaults 2000¢ and
 * 500k) — the same envelope the loop itself stops at, per
 * docs/standards/tech-and-run-budgets.md. Reserving the ceiling makes the gate
 * conservative on purpose: it can refuse a run that would in fact have fitted,
 * and it bounds how far a scope can be admitted past its cap by one such
 * ceiling rather than by the number of replicas. The reservation disappears the
 * moment the run's real spend is recorded, so the pessimism lasts only as long
 * as the uncertainty does.
 */
const runReservationEstimate = (context: RunContext): BudgetReservationEstimate => {
  // The same `agent.runLimits?.[dim] ?? backstop[dim]` rule
  // `resolveEffectiveRunBudget` applies, taken from `resolveRunBackstop`
  // because that one's fields are all present — `BudgetLimits` marks the two
  // dimensions a reservation needs optional.
  const backstop = resolveRunBackstop()
  const limits = context.agent.runLimits
  return {
    costUsd: (limits?.maxCostCents ?? backstop.maxCostCents) / 100,
    tokens: limits?.maxTokens ?? backstop.maxTokens,
  }
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
  if (options.subscriptionPinned === true) {
    return { blocked: false, modelOverride: null }
  }
  // Admission, not observation: for a cap-enforcing budget this reads usage and
  // writes this run's reservation inside one locked transaction, so a run being
  // admitted on another replica at the same instant sees this one's ceiling
  // rather than the same stale pre-run total. The reservation is released when
  // the run records its real spend.
  const evaluation = await admitRunToBudget(
    deps.prisma,
    {
      organizationId: payload.actorContext.tenant.organizationId,
      projectId: payload.actorContext.tenant.projectId,
      teamId: payload.actorContext.tenant.teamId,
    },
    {
      estimate: runReservationEstimate(context),
      isHuman: payload.interactive === true,
      runId: context.run.id,
    },
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
  options: { subscriptionPinned?: boolean } = {},
): (() => Promise<boolean>) => {
  // The pre-run gate just evaluated; start the throttle window from now.
  let lastEvaluatedAt = Date.now()
  let blocked = false

  return async () => {
    // Same reasoning as the pre-run gate: an organization cap must not stop a
    // run the organization is not paying for, mid-flight any more than at the
    // door. The run's own backstop envelope still stops it.
    if (options.subscriptionPinned === true) return false
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
