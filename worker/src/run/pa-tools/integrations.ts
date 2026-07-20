import {
  ProductIntegrationRunStatusSchema,
  type ProductIntegrationRunStatus,
} from '@nessie/schemas'
import {
  attributionFromActorContext,
  reconcileDeepWaterResearchRunUsage,
  updateDeepWaterResearchRun,
  type DeepWaterResearchRunUpdateInput,
} from '@nessie/runtime'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'

const RUN_UPDATE_STATUSES = new Set<ProductIntegrationRunStatus>([
  'running',
  'needs_setup',
  'completed',
  'failed',
  'warning',
])

const nullableString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const nullableNonNegativeNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

const parseStatus = (value: unknown): ProductIntegrationRunStatus => {
  const parsed = ProductIntegrationRunStatusSchema.safeParse(value)
  if (!parsed.success || !RUN_UPDATE_STATUSES.has(parsed.data)) {
    throw new Error('status must be one of running, needs_setup, completed, failed, or warning.')
  }
  return parsed.data
}

export const runDeepWaterRunUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const runId = nullableString(args.runId)
  if (!runId) {
    throw new Error('runId is required.')
  }

  const status = parseStatus(args.status)
  // Tenancy is taken strictly from the run context, never from tool args: the
  // update is scoped to the caller's own team + the thread this run belongs to.
  const teamId =
    context.actorContext.tenant.teamId
    ?? context.actorContext.actionContext.teamId
  if (!teamId) {
    throw new Error('Deep Water run updates require a team context.')
  }
  const costAmount = nullableNonNegativeNumber(args.totalCost)
  const costCurrency = nullableString(args.currency)
  if (args.totalCost !== undefined && costAmount === undefined) {
    throw new Error('totalCost must be a non-negative finite number.')
  }
  if ((costAmount === undefined) !== (costCurrency === undefined)) {
    throw new Error(
      'totalCost and currency must be copied together from Ledger cost.amount and cost.currency.',
    )
  }
  const update: DeepWaterResearchRunUpdateInput = {
    costAmount,
    costCurrency,
    externalRunId: nullableString(args.externalRunId),
    knowledgePageId: nullableString(args.knowledgePageId),
    organizationId: String(context.channel.organizationId),
    runId,
    status,
    statusDetail: nullableString(args.statusDetail),
    teamId: String(teamId),
    threadId: context.run.threadId,
  }

  const updated = await updateDeepWaterResearchRun(context.prisma, update)
  const usage = await reconcileDeepWaterResearchRunUsage(context.prisma, {
    attribution: attributionFromActorContext(context.actorContext, {
      agentId: context.agentId,
      runId: context.run.id,
    }),
    organizationId: String(context.channel.organizationId),
    runId: updated.id,
  })
  const cost =
    updated.totalCost === null
      ? 'cost pending'
      : `${updated.totalCost.toFixed(2)} ${updated.currency ?? 'USD'}`
  const sources =
    updated.sourceCount === null ? 'sources pending' : `${updated.sourceCount} sources`
  const usageNote = usage.recorded ? ', usage ledger recorded' : ''

  return {
    inputSummary: `runId=${updated.id} status=${updated.status}`,
    outputPreview:
      `Updated Deep Water run ${updated.id}: status=${updated.status}, ` +
      `${sources}, ${cost}${usageNote}.`,
    toolName: 'deep_water_run_update',
  }
}
