import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  UoaSessionIdentity,
} from '@nessie/schemas'

import { releaseBudgetReservation } from './budget-reservations.js'
import {
  type ActivePricingProfile,
  calculateEstimatedCost,
  findActivePricingProfile,
} from './ledger-pricing.js'

export {
  currentStorageUsageBytes,
  recordStorageScopeMoved,
  recordStorageStored,
} from './storage-usage-ledger.js'
export type {
  StorageStoreOperation,
  StorageUsageScope,
} from './storage-usage-ledger.js'
export {
  recordConnectorUsage,
  recordStorageTransferUsage,
} from './connector-usage.js'
export type {
  ConnectorType,
  ConnectorUsage,
  StorageTransferOperation,
} from './connector-usage.js'

// Shared operational usage writers. Each metered interaction is attributed for
// diagnostics/local budgets; UOA is the sole commercial authority. Two ledgers:
//   - token_ledger_events    — AI/LLM invocations (tokens + internal estimates)
//   - connector_usage_events — non-AI third-party connectors (calls + units)
// Both are written from the same flat LedgerAttribution so any call site (the
// worker agentic loop, the shared model client, the tool dispatcher) attributes
// identically. @nessie/runtime already owns budget.ts and reads the ledger, so
// the writers live here too.

export type LedgerActorType = 'user' | 'agent' | 'service' | 'system'

// The who/where-from of a metered interaction. organizationId + actorId are the
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
  agentKind?: 'personal_assistant' | 'shared' | 'system' | null
  systemComponent?: string | null
  toolCallId?: string | null
  actorId: string
  actorType?: LedgerActorType | null
  requestId?: string | null
  correlationId?: string | null
  /**
   * Set when this work spends a person's own linked subscription instead of the
   * organization's Ledger credits.
   *
   * The exclusion from organization cost is STRUCTURAL, keyed on this field —
   * never on the absence of a pricing profile. Two things would otherwise lie:
   * connector invocations record the *runtime* provider (`openai-compatible`),
   * not the subscription, and an owner-authored wildcard `ModelPricingProfile`
   * would happily price spend the organization never incurred.
   */
  personalSubscription?: {
    subscriptionId: string
    /** Whose plan paid. Attribution follows the owner, not the poster. */
    ownerUserId: string
  } | null
  /**
   * A run pinned to one owner-controlled local host.  This is intentionally a
   * billing source rather than a provider spelling: local token telemetry is
   * useful, but neither a pricing profile nor a currency cost applies.
   */
  localDevice?: {
    bindingId: string
    hostId: string
  } | null
  // Immutable external proof captured at the originating UOA login. Durable
  // work copies this tuple; callers must never replace it with a newer mutable
  // ProductAccountLink identity after the work/session was created.
  uoaIdentity?: UoaSessionIdentity
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
    agentKind?: 'personal_assistant' | 'shared' | 'system' | null
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
  // Only named system work may clear the authenticated action-context agent.
  agentId:
    extra.agentId === null && extra.systemComponent?.trim()
      ? null
      : extra.agentId ?? actorContext.actionContext.agentId ?? null,
  agentKind: extra.agentKind ?? null,
  systemComponent: extra.systemComponent ?? null,
  actorId: actorContext.actor.actorId,
  actorType: actorContext.actor.actorType,
  requestId: actorContext.actionContext.requestId,
  correlationId: actorContext.actionContext.correlationId ?? null,
  ...(actorContext.actionContext.uoaIdentity
    ? { uoaIdentity: actorContext.actionContext.uoaIdentity }
    : {}),
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
  // A run's invocations almost always share one (provider, model) pair, so look
  // the pricing profile and catalog ids up once per distinct pair instead of
  // once per invocation. Promise caches, so concurrent map callbacks for the
  // same pair await a single query rather than racing duplicates.
  const pricingByPair = new Map<string, Promise<ActivePricingProfile | null>>()
  const idsByPair = new Map<
    string,
    Promise<{ modelId: string | null; providerId: string | null }>
  >()
  const cached = <T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> => {
    const existing = cache.get(key)
    if (existing) return existing
    const pending = load()
    cache.set(key, pending)
    return pending
  }

  const rows = await Promise.all(
    input.invocations.map(async (invocation) => {
      const pairKey = `${invocation.provider}\u0000${invocation.model}`
      // A personal-subscription invocation is never priced. The organization
      // did not pay for it, so an estimate here would flow straight into org
      // cost budgets and owner-facing totals as money nobody spent — and an
      // owner-authored wildcard pricing profile would produce exactly that.
      const localDevice = attribution.localDevice ?? null
      const pricing = attribution.personalSubscription || localDevice
        ? null
        : await cached(pricingByPair, pairKey, () =>
          findActivePricingProfile(
            prisma,
            attribution.organizationId,
            invocation.provider,
            invocation.model,
          ),
        )
      const { modelId, providerId } = localDevice
        ? { modelId: null, providerId: null }
        : await cached(idsByPair, pairKey, () =>
          resolveProviderModelIds(
            prisma,
            attribution.organizationId,
            invocation.provider,
            invocation.model,
          ),
        )
      return {
        inferenceInvocationId: invocation.invocationId,
        organizationId: attribution.organizationId,
        billingSource: localDevice
          ? 'local_device' as const
          : attribution.personalSubscription ? 'personal_subscription' as const : 'ledger' as const,
        modelSubscriptionId: localDevice ? null : attribution.personalSubscription?.subscriptionId ?? null,
        // Whose plan paid, not who happened to post: a colleague's question
        // answered by someone else's agent still spends that owner's plan.
        userId:
          localDevice
          ? attribution.userId ?? null
          : attribution.personalSubscription?.ownerUserId
          ?? attribution.userId
          ?? null,
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
        providerCostAmount: localDevice ? null : invocation.providerReportedCost?.amount ?? null,
        providerCostCurrency: localDevice ? null : invocation.providerReportedCost?.currency ?? null,
        pricingProfileId: localDevice ? null : pricing?.id ?? null,
        pricingSource: pricing?.source ?? null,
        pricingCurrency: pricing?.currency ?? null,
        pricingInputPerM: pricing?.inputPerMillion ?? null,
        pricingOutputPerM: pricing?.outputPerMillion ?? null,
        estimatedCostAmount: localDevice ? null : calculateEstimatedCost(invocation.usage, pricing),
        estimatedCostCurrency: localDevice ? null : pricing?.currency ?? null,
        localInferenceHostId: localDevice?.hostId ?? null,
        localInferenceBindingId: localDevice?.bindingId ?? null,
        occurredAt,
        metadata: {
          invocationId: invocation.invocationId,
          latencyMs: invocation.latencyMs,
          ...(attribution.systemComponent
            ? { systemComponent: attribution.systemComponent }
            : {}),
          ...(attribution.agentKind
            ? { agentKind: attribution.agentKind }
            : {}),
          ...(attribution.toolCallId
            ? { toolCallId: attribution.toolCallId }
            : {}),
          ...(invocation.metadata ?? {}),
        } as Prisma.InputJsonValue,
      }
    }),
  )

  await prisma.tokenLedgerEvent.createMany({ data: rows, skipDuplicates: true })

  // The run's admission reservation was a placeholder for exactly these rows.
  // Now that its real spend is on the ledger, holding the estimate as well
  // would double-count it against the next admitter. Released here rather than
  // on each terminal path because this is the one writer all five of them go
  // through — see budget-reservations.ts.
  if (attribution.runId) {
    await releaseBudgetReservation(prisma, attribution.runId)
  }
}
