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
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, value)
}

const nullableNonNegativeInteger = (value: unknown): number | undefined => {
  const numeric = nullableNonNegativeNumber(value)
  return numeric === undefined ? undefined : Math.trunc(numeric)
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
  const update: DeepWaterResearchRunUpdateInput = {
    costAmount: nullableNonNegativeNumber(args.totalCost),
    costCurrency: nullableString(args.currency),
    externalRunId: nullableString(args.externalRunId),
    knowledgePageId: nullableString(args.knowledgePageId),
    organizationId: String(context.channel.organizationId),
    reportUrl: nullableString(args.reportUrl),
    runId,
    sourceCount: nullableNonNegativeInteger(args.sourceCount),
    status,
    statusDetail: nullableString(args.statusDetail),
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
