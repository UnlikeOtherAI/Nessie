import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

export {
  currentStorageUsageBytes,
  recordStorageStored,
} from './storage-usage-ledger.js'
export type {
  StorageStoreOperation,
  StorageUsageScope,
} from './storage-usage-ledger.js'

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
  userId?: string | null
  projectId?: string | null
  teamId?: string | null
  channelId?: string | null
  threadId?: string | null
  sessionId?: string | null
  taskId?: string | null
  runId?: string | null
  agentId?: string | null
  agentKind?: 'personal_assistant' | 'shared' | null
  systemComponent?: string | null
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

export type StorageTransferOperation = 'download' | 'upload'

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
  // Cache rates fall back to the matching base rate so cached tokens are never
  // billed at $0 when only input/output rates are configured. When a cheaper
  // cache rate IS set, the discount is applied.
  const cacheInputRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion
  if (usage.cachedInputTokens && cacheInputRate) {
    amount += (usage.cachedInputTokens / 1_000_000) * cacheInputRate
  }
  const cacheOutputRate = pricing.cachedOutputPerMillion ?? pricing.outputPerMillion
  if (usage.cachedOutputTokens && cacheOutputRate) {
    amount += (usage.cachedOutputTokens / 1_000_000) * cacheOutputRate
  }
  const cacheReadRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion
  if (usage.cacheReadTokens && cacheReadRate) {
    amount += (usage.cacheReadTokens / 1_000_000) * cacheReadRate
  }
  const cacheWriteRate = pricing.cacheWritePerMillion ?? pricing.inputPerMillion
  if (usage.cacheWriteTokens && cacheWriteRate) {
    amount += (usage.cacheWriteTokens / 1_000_000) * cacheWriteRate
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
  extra: {
    agentId?: string | null
    agentKind?: 'personal_assistant' | 'shared' | null
    runId?: string | null
    systemComponent?: string | null
  } = {},
): LedgerAttribution => ({
  organizationId: actorContext.tenant.organizationId,
  userId:
    actorContext.actionContext.effectiveUserId
    ?? (actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null),
  projectId: actorContext.tenant.projectId ?? null,
  teamId:
    actorContext.tenant.teamId
    ?? actorContext.actionContext.teamId
    ?? null,
  channelId: actorContext.actionContext.channelId ?? null,
  threadId: actorContext.actionContext.threadId ?? null,
  sessionId: actorContext.actionContext.sessionId ?? null,
  taskId: actorContext.actionContext.taskId ?? null,
  runId: extra.runId ?? null,
  agentId: extra.agentId ?? actorContext.actionContext.agentId ?? null,
  agentKind: extra.agentKind ?? null,
  systemComponent: extra.systemComponent ?? null,
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
        userId: attribution.userId ?? null,
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
          ...(attribution.systemComponent
            ? { systemComponent: attribution.systemComponent }
            : {}),
          ...(invocation.metadata ?? {}),
        } as Prisma.InputJsonValue,
      }
    }),
  )

  await prisma.tokenLedgerEvent.createMany({ data: rows, skipDuplicates: true })
}

/**
 * Value historical token usage that was recorded before any pricing existed.
 * estimated_cost_amount is computed at write time, so events logged while the
 * org had no ModelPricingProfile stay null forever. This re-prices ONLY those
 * still-null events using the current active profile per (provider, model) —
 * already-priced rows are left untouched, so historical accuracy is preserved.
 * One arithmetic UPDATE per (provider, model) pair (cheap, exact).
 */
export const recomputeTokenLedgerCosts = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<{ updatedEvents: number; pricedPairs: number; unpricedPairs: number }> => {
  const pairs = await prisma.tokenLedgerEvent.groupBy({
    by: ['provider', 'model'],
    where: { organizationId, estimatedCostAmount: null },
  })

  let updatedEvents = 0
  let pricedPairs = 0
  let unpricedPairs = 0

  for (const pair of pairs) {
    const pricing = await findPricingProfile(prisma, organizationId, pair.provider, pair.model)
    if (!pricing) {
      unpricedPairs += 1
      continue
    }
    // Mirror calculateEstimatedCost: cache rates fall back to the base rate so
    // cached tokens are never valued at $0 when only base rates are set.
    const inputRate = pricing.inputPerMillion ?? 0
    const outputRate = pricing.outputPerMillion ?? 0
    const cacheInputRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion ?? 0
    const cacheOutputRate = pricing.cachedOutputPerMillion ?? pricing.outputPerMillion ?? 0
    const cacheReadRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion ?? 0
    const cacheWriteRate = pricing.cacheWritePerMillion ?? pricing.inputPerMillion ?? 0

    const updated = await prisma.$executeRaw`
      UPDATE token_ledger_events SET
        estimated_cost_amount =
            COALESCE(input_tokens, 0)::numeric / 1000000 * ${inputRate}
          + COALESCE(output_tokens, 0)::numeric / 1000000 * ${outputRate}
          + COALESCE(cached_input_tokens, 0)::numeric / 1000000 * ${cacheInputRate}
          + COALESCE(cached_output_tokens, 0)::numeric / 1000000 * ${cacheOutputRate}
          + COALESCE(cache_read_tokens, 0)::numeric / 1000000 * ${cacheReadRate}
          + COALESCE(cache_write_tokens, 0)::numeric / 1000000 * ${cacheWriteRate},
        estimated_cost_currency = ${pricing.currency},
        pricing_profile_id = ${pricing.id}::uuid
      WHERE organization_id = ${organizationId}::uuid
        AND provider = ${pair.provider}
        AND model = ${pair.model}
        AND estimated_cost_amount IS NULL
    `
    updatedEvents += Number(updated)
    pricedPairs += 1
  }

  return { updatedEvents, pricedPairs, unpricedPairs }
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
      userId: attribution.userId ?? null,
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
      metadata: (
        attribution.systemComponent
          ? {
              ...(event.metadata ?? {}),
              systemComponent: attribution.systemComponent,
            }
          : event.metadata ?? undefined
      ) as Prisma.InputJsonValue | undefined,
    },
  })
}

export const recordStorageTransferUsage = async (
  prisma: PrismaClient,
  input: {
    attribution: LedgerAttribution
    bytes: number
    metadata?: Record<string, unknown>
    operation: StorageTransferOperation
    success?: boolean
    target?: string
    latencyMs?: number
  },
): Promise<void> => {
  await recordConnectorUsage(prisma, {
    attribution: input.attribution,
    event: {
      connectorType: 'storage',
      target: input.target ?? 'attachment',
      operation: input.operation,
      calls: 1,
      units: input.bytes,
      unitType: 'bytes',
      success: input.success ?? true,
      latencyMs: input.latencyMs ?? null,
      metadata: input.metadata ?? null,
    },
  })
}
