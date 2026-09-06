import { enqueueQueueJob } from '@nessie/db'
import type { BudgetAlertSnapshot, BudgetEvaluation } from '@nessie/runtime'
import { BUDGET_ALERT_DISPATCH_TOPIC } from '@nessie/schemas'
import type { BudgetAlertDispatchJobPayload } from '@nessie/schemas'
import type { ExecutionDependencies, RunContext } from './types.js'

/**
 * Budget threshold alerting — a pure observation layer wrapped around the
 * existing budget gate. It NEVER changes the gate verdict: `applyBudgetGate`
 * decides allow/degrade/block exactly as before, then hands the evaluation here
 * so a threshold crossing can be surfaced. Everything below is best-effort and
 * swallows its own errors, so an alerting failure can never fail (or unblock) a
 * run.
 *
 * Two alert kinds, each fired at most once per budget scope per period:
 *   - 'threshold': cumulative spend first reached the warn threshold (level != ok).
 *   - 'blocked':   the gate actually blocked a run (decision.action === 'block').
 *
 * Durable, crash-safe dedupe is a `budget_alerts` marker row with a unique
 * (scopeType, scopeId, periodStart, kind) constraint: the insert uses
 * skipDuplicates, and only the first inserter emits the TaskEvent + notification.
 *
 * This is Nessie-local operational telemetry only — it never reads or emits any
 * UOA customer credit/statement data.
 */

type AlertKind = 'threshold' | 'blocked'

const formatUsd = (value: number): string => `$${value.toFixed(2)}`

const periodWord: Record<BudgetAlertSnapshot['period'], string> = {
  weekly: 'this week',
  monthly: 'this month',
  yearly: 'this year',
}

const resolveScopeLabel = async (
  prisma: ExecutionDependencies['prisma'],
  alert: BudgetAlertSnapshot,
): Promise<string> => {
  if (alert.scopeType === 'team') {
    const team = await prisma.team.findUnique({
      where: { id: alert.scopeId },
      select: { name: true },
    })
    return team?.name ? `Team ${team.name}` : 'Team budget'
  }
  if (alert.scopeType === 'project') {
    const project = await prisma.project.findUnique({
      where: { id: alert.scopeId },
      select: { name: true },
    })
    return project?.name ? `Project ${project.name}` : 'Project budget'
  }
  const organization = await prisma.organization.findUnique({
    where: { id: alert.scopeId },
    select: { name: true },
  })
  return organization?.name ?? 'Organization budget'
}

const thresholdReason = (alert: BudgetAlertSnapshot, scopeLabel: string): string => {
  const pct = alert.percentUsed === null ? '' : `${alert.percentUsed}% — `
  const spend =
    alert.costLimitUsd !== null
      ? `${formatUsd(alert.spentUsd)} of ${formatUsd(alert.costLimitUsd)}`
      : `${alert.spentTokens.toLocaleString()} of ${(alert.tokenLimit ?? 0).toLocaleString()} tokens`
  return `${scopeLabel} has used ${pct}${spend} ${periodWord[alert.period]}.`
}

const emitAlert = async (
  deps: ExecutionDependencies,
  context: RunContext,
  alert: BudgetAlertSnapshot,
  kind: AlertKind,
  scopeLabel: string,
  reason: string,
): Promise<void> => {
  // Durable once-per-period dedupe: only the first inserter proceeds.
  const inserted = await deps.prisma.budgetAlert.createMany({
    data: [
      {
        organizationId: alert.organizationId,
        scopeType: alert.scopeType,
        scopeId: alert.scopeId,
        period: alert.period,
        periodStart: alert.periodStart,
        kind,
        percentUsed: alert.percentUsed,
        spentUsd: alert.spentUsd,
        costLimitUsd: alert.costLimitUsd,
      },
    ],
    skipDuplicates: true,
  })
  if (inserted.count === 0) {
    return
  }

  // Queryable audit trail on the run's task.
  await deps.prisma.taskEvent.create({
    data: {
      eventType: 'budget.threshold_alert',
      payload: {
        kind,
        scopeType: alert.scopeType,
        scopeId: alert.scopeId,
        period: alert.period,
        level: alert.level,
        percentUsed: alert.percentUsed,
        spentUsd: alert.spentUsd,
        costLimitUsd: alert.costLimitUsd,
        spentTokens: alert.spentTokens,
        tokenLimit: alert.tokenLimit,
        reason,
      },
      taskId: context.task.id,
    },
  })

  // Notify owners + scope managers through the shared push pipeline.
  const dispatchPayload: BudgetAlertDispatchJobPayload = {
    organizationId: alert.organizationId,
    scopeType: alert.scopeType,
    scopeId: alert.scopeId,
    kind,
    period: alert.period,
    scopeLabel,
    percentUsed: alert.percentUsed,
    reason,
  }
  await enqueueQueueJob(deps.prisma, {
    idempotencyKey: `budget-alert:${alert.scopeType}:${alert.scopeId}:${alert.periodStart.toISOString()}:${kind}`,
    payload: dispatchPayload,
    topic: BUDGET_ALERT_DISPATCH_TOPIC,
  })
}

/**
 * Fire budget threshold/blocked alerts for a completed gate evaluation. Safe to
 * call unconditionally: it no-ops when there is no governing budget with a
 * limit, when the threshold has not been crossed, and on any internal error.
 */
export const maybeEmitBudgetAlerts = async (
  deps: ExecutionDependencies,
  context: RunContext,
  evaluation: BudgetEvaluation,
): Promise<void> => {
  const { alert, decision } = evaluation
  if (!alert) {
    return
  }
  const wantsThreshold = alert.level !== 'ok'
  const wantsBlocked = decision.action === 'block'
  if (!wantsThreshold && !wantsBlocked) {
    return
  }

  try {
    const scopeLabel = await resolveScopeLabel(deps.prisma, alert)
    if (wantsThreshold) {
      await emitAlert(deps, context, alert, 'threshold', scopeLabel, thresholdReason(alert, scopeLabel))
    }
    if (wantsBlocked) {
      const reason =
        decision.action === 'block'
          ? decision.reason
          : thresholdReason(alert, scopeLabel)
      await emitAlert(deps, context, alert, 'blocked', scopeLabel, reason)
    }
  } catch (error) {
    console.error(
      '[worker] budget alert emission failed for run',
      context.run.id,
      error,
    )
  }
}
