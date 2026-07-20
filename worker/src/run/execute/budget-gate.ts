import { checkBudget } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { buildScopes } from './scopes.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus } from './lifecycle.js'
import { publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import type { BudgetModelOverride, ExecutionDependencies, RunContext } from './types.js'

type BudgetBlockOptions = {
  beforeBlockedRunTerminalization?: () => Promise<void>
}

export const terminalizeBudgetBlockedRun = async (
  deps: ExecutionDependencies,
  context: RunContext,
  reason: string,
  options: BudgetBlockOptions,
): Promise<void> => {
  await options.beforeBlockedRunTerminalization?.()
  const notice = `⚠️ ${reason} — this request was not run.`
  const blockMessage = await deps.prisma.message.create({
    data: {
      agentId: context.agent.id,
      content: notice,
      role: 'assistant',
      threadId: context.run.threadId,
    },
  })
  await publishMessageCreated(deps.realtimeTransport, context, {
    content: blockMessage.content,
    messageId: blockMessage.id,
    role: blockMessage.role,
  })
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
  const budgetDecision = await checkBudget(
    deps.prisma,
    {
      organizationId: payload.actorContext.tenant.organizationId,
      projectId: payload.actorContext.tenant.projectId,
      teamId: payload.actorContext.tenant.teamId,
    },
    { isHuman: payload.interactive === true },
  )
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
    await terminalizeBudgetBlockedRun(deps, context, budgetDecision.reason, options)
    return { blocked: true }
  }

  return { blocked: false, modelOverride: budgetModelOverride }
}
