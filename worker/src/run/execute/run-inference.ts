import { loadConfig } from '@nessie/config'
import {
  attributionFromActorContext,
  createInferenceService,
  isLedgerEndpoint,
  type InferenceResult,
  type InvocationRecord,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'
import {
  parseRunId,
  reasoningEffortForAgentEffort,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { KB_DOCUMENT_COMPOSE_TOOL_ID } from '@nessie/runtime'
import { findLedgerModelOutputTokenCap } from '@nessie/team-admin'
import { runInferenceGraph } from '../inference.js'
import { resolveRuntimeProvider, resolveStageProviderConfig } from '../inference-provider.js'
import {
  resolveComposeOutputTokens,
  startCancellationPoll,
} from './document-cancel-poll.js'
import { createProviderRequestHeadersResolver } from '../inference-identity.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import type { UtilityModel } from './utility-model.js'
import type { BudgetModelOverride, ExecutionDependencies, RunContext } from './types.js'
import type { RunSubscriptionBinding } from './subscription-binding.js'
import { runReplyIsRestricted } from './agent-message.js'
import { createStreamRedactor } from './stream-redaction.js'

const runtimeModelConfig = loadConfig().model

export const hasDocumentComposeTool = (tools: ToolSchemaDescriptor[]): boolean =>
  tools.some((tool) => tool.toolName === KB_DOCUMENT_COMPOSE_TOOL_ID)

export const resolveAdvertisedOutputTokens = (input: {
  configuredMaxTokens: number
  staticMaxOutputTokens?: number
  ledgerMaxOutputTokens?: number
}): number => Math.min(
  input.configuredMaxTokens,
  input.staticMaxOutputTokens ?? Number.POSITIVE_INFINITY,
  input.ledgerMaxOutputTokens ?? Number.POSITIVE_INFINITY,
)

export const resolveMainOutputTokens = (input: {
  admittedMaxOutputTokens?: number
  composeAvailable: boolean
  configuredMaxTokens: number
}): number | undefined => {
  if (!input.composeAvailable) return input.admittedMaxOutputTokens
  return Math.min(
    resolveComposeOutputTokens(input.configuredMaxTokens),
    input.admittedMaxOutputTokens ?? Number.POSITIVE_INFINITY,
  )
}

/**
 * How this run calls the model. One construction point for every inference the
 * run makes — the main turn, delegate sub-agents, compaction and checkpoint
 * notes — so all of them carry identical routing, credentials, and signed
 * attribution. Only the model id and the streaming callbacks differ.
 */
export type RunInference = {
  /** True when the current main turn already streamed text to the thread. */
  consumeStreamedFlag: () => boolean
  mainOutputTokens?: () => Promise<number>
  runMain: (
    messages: ProviderMessage[],
    tools: ToolSchemaDescriptor[],
    options?: { maxOutputTokens?: number },
  ) => Promise<InferenceResult>
  /**
   * Silent, non-streaming inference on the pinned utility model (falling back
   * to the run's own model). Used by sub-agents and by the note calls.
   */
  runUtility: (
    messages: ProviderMessage[],
    tools: ToolSchemaDescriptor[],
  ) => Promise<InferenceResult>
}

export const createRunInference = (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  options: {
    budgetModelOverride: BudgetModelOverride | null
    // Durable thought log for the main turn: the recorder persists each
    // coalesced reasoning chunk and publishes the matching `stream.reasoning`
    // event with that chunk's id (one publish per flush, never per token).
    // Utility calls (sub-agents, compaction, checkpoint notes) stay silent.
    /**
     * The run's pinned personal-subscription lane, or null for the ordinary
     * Ledger route. Every call this factory makes — main turn, delegates,
     * compaction, checkpoint notes — carries the same binding, so a run never
     * mixes a person's plan with the organization's credits.
     */
    subscription: RunSubscriptionBinding | null
    /** Narrow test seams; production uses the imported resolvers. */
    stageProviderResolver?: typeof resolveStageProviderConfig
    inferenceServiceFactory?: typeof createInferenceService
    ledgerCatalogFetch?: typeof fetch
    thinkingRecorder: ThinkingRecorder
    utilityModel: UtilityModel | null
  },
): RunInference => {
  let currentTurnStreamed = false
  const reasoningEffort = reasoningEffortForAgentEffort(context.agent.effort)
  const requestHeadersForProvider = createProviderRequestHeadersResolver({
    attribution: attributionFromActorContext(payload.actorContext, {
      agentId: context.agent.id,
      agentKind: context.agent.agentKind,
      runId: context.run.id,
    }),
    ledgerIdentity: deps.ledgerIdentity,
  })

  const runModel = {
    model: options.budgetModelOverride?.model ?? context.agent.model,
    provider: options.budgetModelOverride?.provider ?? context.agent.provider,
  }

  const mainOutputTokens = async (): Promise<number> => {
    const providerConfig = await (options.stageProviderResolver ?? resolveStageProviderConfig)(deps.prisma, {
      modelConfig: runtimeModelConfig,
      organizationId: context.channel.organizationId,
      providerKey: runModel.provider ?? runtimeModelConfig.provider,
      requestedModel: runModel.model ?? runtimeModelConfig.modelName ?? '',
      routeSource: 'direct',
      subscription: options.subscription
        ? {
          ownerUserId: options.subscription.ownerUserId,
          secretStore: deps.subscriptionSecrets ?? null,
          subscriptionId: options.subscription.subscriptionId,
        }
        : null,
    })
    const runtimeProvider = resolveRuntimeProvider(providerConfig.providerKey)
      ?? (providerConfig.connectorKind === 'openai-compatible'
        || isLedgerEndpoint(providerConfig.baseUrl)
        ? 'openai-compatible'
        : null)
    if (!runtimeProvider) return runtimeModelConfig.maxTokens
    const service = (options.inferenceServiceFactory ?? createInferenceService)({
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      ...(providerConfig.extraHeaders ? { extraHeaders: providerConfig.extraHeaders } : {}),
      modelName: providerConfig.model,
      provider: runtimeProvider,
      serviceId: providerConfig.providerKey,
    })
    const capability = await service.getCapabilities(providerConfig.model)
    let ledgerMaxOutputTokens: number | undefined
    if (providerConfig.baseUrl && isLedgerEndpoint(providerConfig.baseUrl) && providerConfig.model) {
      try {
        const requestHeaders = await requestHeadersForProvider(providerConfig)
        ledgerMaxOutputTokens = await findLedgerModelOutputTokenCap({
          config: { apiKey: providerConfig.apiKey, baseUrl: providerConfig.baseUrl },
          ledgerPublicUrl: new URL(providerConfig.baseUrl).origin,
          model: providerConfig.model,
          provider: providerConfig.providerKey,
          ...(requestHeaders ? { requestHeaders } : {}),
          ...(options.ledgerCatalogFetch ? { fetchImpl: options.ledgerCatalogFetch } : {}),
        })
      } catch {
        // Ledger metadata is advisory. Its absence or a transient listing failure
        // must retain the configured cap rather than invent a provider limit.
      }
    }
    return resolveAdvertisedOutputTokens({
      configuredMaxTokens: runtimeModelConfig.maxTokens,
      staticMaxOutputTokens: capability.effectiveSnapshot.maxOutputTokens,
      ledgerMaxOutputTokens,
    })
  }

  const call = async (
    messages: ProviderMessage[],
    tools: ToolSchemaDescriptor[],
    agentModel: { model: string | null; provider: string | null },
    streaming: boolean,
    maxOutputTokens?: number,
  ): Promise<InferenceResult> => {
    const documentStream = streaming ? deps.documentStream : undefined
    // A document is emitted as tool-call arguments inside one completion, so
    // the ordinary per-call output cap would truncate it mid-sentence. When the
    // tool is on the table this call asks for the model's own maximum instead;
    // the run budget, not this number, remains the spend envelope.
    const composeAvailable = hasDocumentComposeTool(tools)
    const controller = documentStream ? new AbortController() : null
    const cancelPoll = controller
      ? startCancellationPoll({
        documentStream,
        onCancelled: () => controller.abort(),
        prisma: deps.prisma,
        runId: context.run.id,
      })
      : null

    const streamRedactor = createStreamRedactor()

    try {
      const mpr = await runInferenceGraph(deps.prisma, {
        actorContext: payload.actorContext,
        agent: {
          id: context.agent.id,
          model: agentModel.model,
          provider: agentModel.provider,
          routingProfileId: null,
        },
        baseMessages: messages,
        maxOutputTokensOverride: resolveMainOutputTokens({
          admittedMaxOutputTokens: maxOutputTokens,
          composeAvailable,
          configuredMaxTokens: runtimeModelConfig.maxTokens,
        }),
        modelConfig: runtimeModelConfig,
        subscription: options.subscription
          ? {
            ownerUserId: options.subscription.ownerUserId,
            secretStore: deps.subscriptionSecrets ?? null,
            subscriptionId: options.subscription.subscriptionId,
          }
          : null,
        onInferenceAttempt: ({ invocationId }) => {
          documentStream?.beginInvocation(invocationId)
        },
        onToolCallDelta: (event) => {
          documentStream?.handleToolCallDelta(event)
        },
        onVisibleReasoningDelta: async (chunk) => {
          if (!streaming) return
          await options.thinkingRecorder.appendReasoning(chunk)
        },
        onVisibleTextDelta: async (chunk) => {
          if (!streaming) return
          currentTurnStreamed = true
          // The SSE stream is one broadcast to everyone watching the thread, so
          // it cannot be filtered per viewer the way the finished message is.
          // Once this run has consumed a source the room does not already imply,
          // its remaining text is withheld from the live lane entirely and read
          // back through the disclosure predicate instead.
          if (runReplyIsRestricted(context)) return
          // Emission trails the stream so a credential split across chunks is
          // never broadcast before the scanner has seen all of it.
          const safe = streamRedactor.push(chunk)
          if (!safe) return
          await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
            content: safe,
            runId: parseRunId(context.run.id),
          })
        },
        organizationId: context.channel.organizationId,
        reasoningEffort,
        requestHeadersForProvider,
        signal: controller?.signal,
        // Note/compaction calls carry no tools at all; providers reject an empty
        // tool array, so the whole tool block is omitted instead.
        ...(tools.length > 0 ? { toolChoice: 'auto' as const, tools } : {}),
      })
      // The stream trails by a held-back tail; release it now the provider is
      // done, or the live lane ends short of the message it was previewing.
      const tail = streamRedactor.flush()
      if (tail && streaming && !runReplyIsRestricted(context)) {
        await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
          content: tail,
          runId: parseRunId(context.run.id),
        })
      }
      if (
        mpr.status !== 'completed'
        || (!mpr.finalAnswer?.trim() && mpr.toolCalls.length === 0)
      ) {
        throw new Error(mpr.failure?.message ?? 'Inference execution produced no final answer')
      }
      return {
        correlationId: mpr.correlationId,
        finishReason: mpr.invocations[0]?.finishReason,
        invocations: mpr.invocations as unknown as InvocationRecord[],
        model: mpr.invocations[0]?.model ?? '',
        outputText: mpr.finalAnswer ?? '',
        provider: (mpr.invocations[0]?.provider ?? 'openai') as InferenceResult['provider'],
        requestId: mpr.requestId,
        toolCalls: mpr.toolCalls,
      }
    } finally {
      cancelPoll?.stop()
    }
  }

  return {
    consumeStreamedFlag: () => {
      const streamed = currentTurnStreamed
      currentTurnStreamed = false
      return streamed
    },
    mainOutputTokens,
    runMain: (messages, tools, callOptions) => {
      currentTurnStreamed = false
      return call(messages, tools, runModel, true, callOptions?.maxOutputTokens)
    },
    runUtility: (messages, tools) =>
      call(
        messages,
        tools,
        options.utilityModel
          ? { model: options.utilityModel.model, provider: options.utilityModel.provider }
          : runModel,
        false,
      ),
  }
}
