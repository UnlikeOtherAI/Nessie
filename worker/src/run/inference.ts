import type { PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import {
  attributionFromActorContext,
  recordInferenceUsage,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import type {
  AuthorizedActionContext,
  InvocationRecord,
  MultiProviderFailure,
  MultiProviderResult,
  ProviderReasoningEffort,
  RouteStage,
  RoutingMode,
} from '@nessie/schemas'
import {
  resolveModelName,
  resolveRuntimeProvider,
  type StageSubscriptionBinding,
} from './inference-provider.js'
import type { ProviderRequestHeadersResolver } from './inference-identity.js'
import { executeStage } from './inference-stage.js'

export { resolveStageApiKey } from './inference-provider.js'
export { buildPromptCacheKey } from './inference-stage.js'

type RunInferenceGraphInput = {
  actorContext: AuthorizedActionContext
  agent: {
    id: string
    model: string | null
    provider: string | null
    routingProfileId: string | null
  }
  baseMessages: ProviderMessage[]
  modelConfig: ModelConfig
  maxOutputTokensOverride?: number
  onInferenceAttempt?: (attempt: { invocationId: string }) => void
  onToolCallDelta?: (event: {
    id: string
    index: number
    invocationId: string
    text: string
    toolName: string
  }) => void
  onVisibleReasoningDelta?: (delta: string) => Promise<void>
  onVisibleTextDelta?: (delta: string) => Promise<void>
  signal?: AbortSignal
  organizationId: string
  reasoningEffort?: ProviderReasoningEffort
  requestHeadersForProvider?: ProviderRequestHeadersResolver
  /**
   * The run's pinned personal-subscription lane. Present for every call in a
   * subscription-routed run — main turn, delegates, compaction — so no single
   * run mixes a person's plan with the organization's Ledger credits.
   */
  subscription?: StageSubscriptionBinding | null
  tools?: ToolSchemaDescriptor[]
  toolChoice?: 'auto' | 'none' | 'required'
}

type PersistInvocationLedgerInput = {
  actorContext: AuthorizedActionContext
  agentId: string
  runId?: string | null
  invocations: InvocationRecord[]
}

type ResolvedRoute = {
  mode: RoutingMode
  profileId?: string
  stages: RouteStage[]
  streamLive: boolean
}

const toFailure = (
  input: {
    code: string
    message: string
    stageId?: string
  },
): MultiProviderFailure => ({
  code: input.code,
  message: input.message,
  stageId: input.stageId,
})

const buildDirectRoute = (
  input: {
    model: string | null
    provider: string | null
  },
  modelConfig: ModelConfig,
): ResolvedRoute => {
  // The provider key doubles as Ledger's `/v1/:serviceId` segment (see
  // `resolveLedgerServiceBaseUrl`), which is why a configured service id wins
  // over the compiled provider name: a deployment default on a Ledger service
  // with no compiled adapter — Meta's `muse-spark-*`, say — must address
  // `/v1/meta`, not `/v1/openai`. An agent's explicit selection still wins over
  // both. `resolveRuntimeProvider` returns null for such a key and the stage
  // falls back to the generic OpenAI-compatible connector.
  const providerKey =
    input.provider?.trim() || modelConfig.serviceId || modelConfig.provider
  const runtimeProvider = resolveRuntimeProvider(providerKey)
  const model =
    runtimeProvider
    && runtimeProvider !== 'openai-compatible'
    && runtimeProvider !== 'codex-subscription'
      ? resolveModelName(runtimeProvider, input.model ?? modelConfig.modelName)
      : input.model?.trim() || modelConfig.modelName

  if (!model) {
    throw new Error(`Direct route ${providerKey} is missing a model`)
  }

  return {
    mode: 'single',
    stages: [
      {
        id: 'direct',
        model,
        provider: providerKey,
        role: 'executor',
        userVisible: true,
      },
    ],
    streamLive: true,
  }
}

const executeSingleMode = async (
  prisma: PrismaClient,
  input: {
    actorContext: AuthorizedActionContext
    baseMessages: ProviderMessage[]
    modelConfig: ModelConfig
    maxOutputTokensOverride?: number
    onInferenceAttempt?: (attempt: { invocationId: string }) => void
    onToolCallDelta?: (event: {
      id: string
      index: number
      invocationId: string
      text: string
      toolName: string
    }) => void
    onVisibleReasoningDelta?: (delta: string) => Promise<void>
    onVisibleTextDelta?: (delta: string) => Promise<void>
    signal?: AbortSignal
    organizationId: string
    reasoningEffort?: ProviderReasoningEffort
    route: ResolvedRoute
    routeSource: 'direct' | 'routing-profile'
    requestHeadersForProvider?: ProviderRequestHeadersResolver
    subscription?: StageSubscriptionBinding | null
    tools?: ToolSchemaDescriptor[]
    toolChoice?: 'auto' | 'none' | 'required'
  },
): Promise<MultiProviderResult> => {
  const stage = input.route.stages[0]
  if (!stage) {
    return {
      correlationId: input.actorContext.actionContext.correlationId,
      failure: toFailure({
        code: 'INFERENCE_SINGLE_NO_STAGE',
        message: 'Single route has no stage',
      }),
      invocations: [],
      requestId: input.actorContext.actionContext.requestId,
      status: 'failed',
      toolCalls: [],
      toolExecutionOwner: null,
    }
  }

  const success = await executeStage(prisma, {
    actorContext: input.actorContext,
    baseMessages: input.baseMessages,
    emitBufferedOutput: !input.route.streamLive,
    mode: input.route.mode,
    maxOutputTokensOverride: input.maxOutputTokensOverride,
    modelConfig: input.modelConfig,
    onInferenceAttempt: input.onInferenceAttempt,
    onToolCallDelta: input.onToolCallDelta,
    onVisibleReasoningDelta: input.onVisibleReasoningDelta,
    onVisibleTextDelta: input.onVisibleTextDelta,
    organizationId: input.organizationId,
    profileId: input.route.profileId,
    signal: input.signal,
    reasoningEffort: input.reasoningEffort,
    routeSource: input.routeSource,
    requestHeadersForProvider: input.requestHeadersForProvider,
    subscription: input.subscription ?? null,
    stage,
    stageIndex: 0,
    stream: input.route.streamLive,
    toolChoice: input.toolChoice,
    tools: input.tools,
    upstream: [],
  })

  return {
    answerOwner: {
      invocationId: success.invocation.invocationId,
      model: success.invocation.model,
      provider: success.invocation.provider,
      stageId: stage.id,
      stageRole: stage.role,
    },
    correlationId: input.actorContext.actionContext.correlationId,
    finalAnswer: success.candidate.outputText,
    invocations: [success.invocation],
    requestId: input.actorContext.actionContext.requestId,
    status: 'completed',
    toolCalls: success.toolCalls,
    toolExecutionOwner:
      success.toolCalls.length > 0
        ? {
            invocationId: success.invocation.invocationId,
            model: success.invocation.model,
            provider: success.invocation.provider,
            stageId: stage.id,
          }
        : null,
  }
}

export const runInferenceGraph = async (
  prisma: PrismaClient,
  input: RunInferenceGraphInput,
): Promise<MultiProviderResult> => {
  // Inference always runs a single direct stage: the agent's provider/model,
  // executed via `executeSingleMode`. Multi-stage routing profiles
  // (fallback/committee/pipeline/shadow) were never reachable — agents never
  // persist a routing profile id — and have been removed.
  const route = buildDirectRoute(
    {
      model: input.agent.model,
      provider: input.agent.provider,
    },
    input.modelConfig,
  )

  return executeSingleMode(prisma, {
    actorContext: input.actorContext,
    baseMessages: input.baseMessages,
    maxOutputTokensOverride: input.maxOutputTokensOverride,
    modelConfig: input.modelConfig,
    onInferenceAttempt: input.onInferenceAttempt,
    onToolCallDelta: input.onToolCallDelta,
    onVisibleReasoningDelta: input.onVisibleReasoningDelta,
    onVisibleTextDelta: input.onVisibleTextDelta,
    organizationId: input.organizationId,
    reasoningEffort: input.reasoningEffort,
    route,
    signal: input.signal,
    routeSource: 'direct',
    requestHeadersForProvider: input.requestHeadersForProvider,
    subscription: input.subscription ?? null,
    toolChoice: input.toolChoice,
    tools: input.tools,
  })
}

// The agentic loop's invocations are billed through the shared ledger writer
// (@nessie/runtime), the same path the API shared model client uses — one writer,
// one attribution shape. Attribution is derived from the run's actorContext plus
// the agent and run ids, so token spend ties back to org/project/team/channel/
// thread/task/agent/actor/run.
/**
 * Which purse a run spent is read from the run's OWN pin rather than passed in
 * by each caller.
 *
 * Five terminal paths write ledger events (completion, failure, cancel,
 * suspend, outcome). Threading a flag through all five is exactly the shape
 * where one gets forgotten and a personal-subscription run silently reports as
 * organization spend, so the obligation sits on the single writer instead.
 */
const loadRunBillingSource = async (
  prisma: PrismaClient,
  runId: string | null | undefined,
): Promise<{ subscriptionId: string; ownerUserId: string } | null> => {
  if (!runId) return null
  const run = await prisma.run.findUnique({
    select: { modelSubscription: { select: { id: true, userId: true } } },
    where: { id: runId },
  })
  const subscription = run?.modelSubscription
  return subscription
    ? { ownerUserId: subscription.userId, subscriptionId: subscription.id }
    : null
}

export const persistInvocationLedgerEvents = async (
  prisma: PrismaClient,
  input: PersistInvocationLedgerInput,
): Promise<void> => {
  const personalSubscription = await loadRunBillingSource(prisma, input.runId)
  await recordInferenceUsage(prisma, {
    attribution: {
      ...attributionFromActorContext(input.actorContext, {
        agentId: input.agentId,
        runId: input.runId ?? null,
      }),
      personalSubscription,
    },
    invocations: input.invocations,
  })
}
