import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

// Shared usage-ledger writers. Every billable interaction is recorded once,
// here, with full attribution (who / where-from / how-much). Two ledgers:
//   - token_ledger_events    — AI/LLM invocations (tokens + cost)
//   - connector_usage_events — non-AI third-party connectors (calls + units)
// Both are written from the same flat LedgerAttribution so any call site (the
// worker agentic loop, the shared model client, the tool dispatcher) attributes
// identically. @nessie/runtime already owns budget.ts and reads the ledger, so
// the writers live here too.

export type LedgerActorType = 'user' | 'agent' | 'service' | 'system'

// The who/where-from of a billable interaction. organizationId + actorId are the
// only hard requirements; everything else is present when known.
export type LedgerAttribution = {
  organizationId: string
  projectId?: string | null
  teamId?: string | null
  channelId?: string | null
  threadId?: string | null
  sessionId?: string | null
  taskId?: string | null
  runId?: string | null
  agentId?: string | null
  actorId: string
  actorType?: LedgerActorType | null
  requestId?: string | null
  correlationId?: string | null
}

// Structural subset of an inference InvocationRecord the writer needs. Both the
// @nessie/schemas InvocationRecord (provider: string) and the runtime
// InvocationRecord (provider: ModelProviderName) are assignable to this.
export type LedgerInvocation = {
  invocationId: string
  requestId: string
  correlationId?: string
  provider: string
  model: string
  operationType: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    cachedOutputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    totalTokens?: number
  }
  providerReportedCost?: { amount: number; currency: string }
  latencyMs: number
  metadata?: Record<string, unknown>
}

export type ConnectorType =
  | 'mcp'
  | 'http'
  | 'web_search'
  | 'web_fetch'
  | 'storage'
  | 'push'
  | 'github'
  | 'oauth'
  | 'other'

export type ConnectorUsage = {
  connectorType: ConnectorType
  connectorId?: string | null
  target?: string | null
  operation?: string | null
  calls?: number
  units?: number | null
  unitType?: string | null
  costAmount?: number | null
  costCurrency?: string | null
  success?: boolean | null
  latencyMs?: number | null
  metadata?: Record<string, unknown> | null
}

type PrismaOperationType =
  | 'chat'
  | 'completion'
  | 'embedding'
  | 'translation'
  | 'reasoning'
  | 'tool_translation'
  | 'other'

const OPERATION_TYPES: ReadonlySet<PrismaOperationType> = new Set([
  'chat',
  'completion',
  'embedding',
  'translation',
  'reasoning',
  'tool_translation',
  'other',
])

const toPrismaOperationType = (operationType: string): PrismaOperationType => {
  if (operationType === 'tool-translation') {
    return 'tool_translation'
  }
  return OPERATION_TYPES.has(operationType as PrismaOperationType)
    ? (operationType as PrismaOperationType)
    : 'other'
}

type PricingProfile = {
  id: string
  source: 'provider_default' | 'org_override' | 'team_override' | 'manual'
  currency: string
  inputPerMillion: number | null
  outputPerMillion: number | null
  cachedInputPerMillion: number | null
  cachedOutputPerMillion: number | null
  cacheReadPerMillion: number | null
  cacheWritePerMillion: number | null
}

const decimalToNumber = (value: { toNumber: () => number } | null): number | null =>
  value === null ? null : value.toNumber()

const findPricingProfile = async (
  prisma: PrismaClient,
  organizationId: string,
  provider: string,
  model: string,
): Promise<PricingProfile | null> => {
  const row = await prisma.modelPricingProfile.findFirst({
    where: {
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] }],
      organizationId,
      OR: [{ modelPattern: model }, { modelPattern: '*' }],
      provider,
    },
    orderBy: { modelPattern: 'desc' },
    select: {
      cacheReadPerMillion: true,
      cacheWritePerMillion: true,
      cachedInputPerMillion: true,
      cachedOutputPerMillion: true,
      currency: true,
      id: true,
      inputPerMillion: true,
      outputPerMillion: true,
      source: true,
    },
  })
  if (!row) {
    return null
  }
  return {
    id: row.id,
    source: row.source,
    currency: row.currency,
    inputPerMillion: decimalToNumber(row.inputPerMillion),
    outputPerMillion: decimalToNumber(row.outputPerMillion),
    cachedInputPerMillion: decimalToNumber(row.cachedInputPerMillion),
    cachedOutputPerMillion: decimalToNumber(row.cachedOutputPerMillion),
    cacheReadPerMillion: decimalToNumber(row.cacheReadPerMillion),
    cacheWritePerMillion: decimalToNumber(row.cacheWritePerMillion),
  }
}

const calculateEstimatedCost = (
  usage: LedgerInvocation['usage'],
  pricing: PricingProfile | null,
): number | null => {
  if (!pricing) {
    return null
  }
  let amount = 0
  if (usage.inputTokens && pricing.inputPerMillion) {
    amount += (usage.inputTokens / 1_000_000) * pricing.inputPerMillion
  }
  if (usage.outputTokens && pricing.outputPerMillion) {
    amount += (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  }
  if (usage.cachedInputTokens && pricing.cachedInputPerMillion) {
    amount += (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion
  }
  if (usage.cachedOutputTokens && pricing.cachedOutputPerMillion) {
    amount += (usage.cachedOutputTokens / 1_000_000) * pricing.cachedOutputPerMillion
  }
  if (usage.cacheReadTokens && pricing.cacheReadPerMillion) {
    amount += (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion
  }
  if (usage.cacheWriteTokens && pricing.cacheWritePerMillion) {
    amount += (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion
  }
  return amount
}

// Resolve the inference-catalog ids for the denormalized provider/model strings.
// Returns nulls for providers/models not in the org catalog (e.g. the shared
// model client's global config) — the strings remain the durable record.
const resolveProviderModelIds = async (
  prisma: PrismaClient,
  organizationId: string,
  provider: string,
  model: string,
): Promise<{ modelId: string | null; providerId: string | null }> => {
  const providerRow = await prisma.inferenceProvider.findFirst({
    where: { organizationId, providerKey: provider },
    select: { id: true },
  })
  if (!providerRow) {
    return { modelId: null, providerId: null }
  }
  const modelRow = await prisma.inferenceModel.findFirst({
    where: { organizationId, providerId: providerRow.id, model },
    select: { id: true },
  })
  return { modelId: modelRow?.id ?? null, providerId: providerRow.id }
}

/**
 * Build a LedgerAttribution from an AuthorizedActionContext. `extra` supplies
 * ids the context does not carry on its own (runId) or overrides (agentId).
 */
export const attributionFromActorContext = (
  actorContext: AuthorizedActionContext,
  extra: { agentId?: string | null; runId?: string | null } = {},
): LedgerAttribution => ({
  organizationId: actorContext.tenant.organizationId,
  projectId: actorContext.tenant.projectId ?? null,
  teamId: actorContext.tenant.teamId ?? null,
  channelId: actorContext.actionContext.channelId ?? null,
  threadId: actorContext.actionContext.threadId ?? null,
  sessionId: actorContext.actionContext.sessionId ?? null,
  taskId: actorContext.actionContext.taskId ?? null,
  runId: extra.runId ?? null,
  agentId: extra.agentId ?? actorContext.actionContext.agentId ?? null,
  actorId: actorContext.actor.actorId,
  actorType: actorContext.actor.actorType,
  requestId: actorContext.actionContext.requestId,
  correlationId: actorContext.actionContext.correlationId ?? null,
})

/**
 * Record one token_ledger_events row per inference invocation, with pricing and
 * cost resolved per org. Idempotent on inferenceInvocationId (skipDuplicates) so
 * a redelivered run is a no-op rather than double-counting.
 */
export const recordInferenceUsage = async (
  prisma: PrismaClient,
  input: { attribution: LedgerAttribution; invocations: LedgerInvocation[] },
): Promise<void> => {
  const { attribution } = input
  if (input.invocations.length === 0) {
    return
  }
  const occurredAt = new Date()
  const rows = await Promise.all(
    input.invocations.map(async (invocation) => {
      const pricing = await findPricingProfile(
        prisma,
        attribution.organizationId,
        invocation.provider,
        invocation.model,
      )
      const { modelId, providerId } = await resolveProviderModelIds(
        prisma,
        attribution.organizationId,
        invocation.provider,
        invocation.model,
      )
      return {
        inferenceInvocationId: invocation.invocationId,
        organizationId: attribution.organizationId,
        projectId: attribution.projectId ?? null,
        teamId: attribution.teamId ?? null,
        channelId: attribution.channelId ?? null,
        threadId: attribution.threadId ?? null,
        sessionId: attribution.sessionId ?? null,
        taskId: attribution.taskId ?? null,
        runId: attribution.runId ?? null,
        agentId: attribution.agentId ?? null,
        actorId: attribution.actorId,
        actorType: attribution.actorType ?? null,
        requestId: attribution.requestId ?? invocation.requestId,
        correlationId: attribution.correlationId ?? invocation.correlationId ?? null,
        provider: invocation.provider,
        model: invocation.model,
        providerId,
        modelId,
        operationType: toPrismaOperationType(invocation.operationType),
        inputTokens: invocation.usage.inputTokens ?? null,
        outputTokens: invocation.usage.outputTokens ?? null,
        cachedInputTokens: invocation.usage.cachedInputTokens ?? null,
        cachedOutputTokens: invocation.usage.cachedOutputTokens ?? null,
        cacheReadTokens: invocation.usage.cacheReadTokens ?? null,
        cacheWriteTokens: invocation.usage.cacheWriteTokens ?? null,
        totalTokens: invocation.usage.totalTokens ?? null,
        providerCostAmount: invocation.providerReportedCost?.amount ?? null,
        providerCostCurrency: invocation.providerReportedCost?.currency ?? null,
        pricingProfileId: pricing?.id ?? null,
        pricingSource: pricing?.source ?? null,
        pricingCurrency: pricing?.currency ?? null,
        pricingInputPerM: pricing?.inputPerMillion ?? null,
        pricingOutputPerM: pricing?.outputPerMillion ?? null,
        estimatedCostAmount: calculateEstimatedCost(invocation.usage, pricing),
        estimatedCostCurrency: pricing?.currency ?? null,
        occurredAt,
        metadata: {
          invocationId: invocation.invocationId,
          latencyMs: invocation.latencyMs,
          ...(invocation.metadata ?? {}),
        } as Prisma.InputJsonValue,
      }
    }),
  )

  await prisma.tokenLedgerEvent.createMany({ data: rows, skipDuplicates: true })
}

/** Record one connector_usage_events row for a non-AI third-party connector call. */
export const recordConnectorUsage = async (
  prisma: PrismaClient,
  input: { attribution: LedgerAttribution; event: ConnectorUsage },
): Promise<void> => {
  const { attribution, event } = input
  await prisma.connectorUsageEvent.create({
    data: {
      organizationId: attribution.organizationId,
      projectId: attribution.projectId ?? null,
      teamId: attribution.teamId ?? null,
      channelId: attribution.channelId ?? null,
      threadId: attribution.threadId ?? null,
      taskId: attribution.taskId ?? null,
      runId: attribution.runId ?? null,
      agentId: attribution.agentId ?? null,
      actorId: attribution.actorId,
      actorType: attribution.actorType ?? null,
      requestId: attribution.requestId ?? null,
      correlationId: attribution.correlationId ?? null,
      connectorType: event.connectorType,
      connectorId: event.connectorId ?? null,
      target: event.target ?? null,
      operation: event.operation ?? null,
      calls: event.calls ?? 1,
      units: event.units ?? null,
      unitType: event.unitType ?? null,
      costAmount: event.costAmount ?? null,
      costCurrency: event.costCurrency ?? null,
      success: event.success ?? null,
      latencyMs: event.latencyMs ?? null,
      occurredAt: new Date(),
      metadata: (event.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}
