import { loadConfig } from '@nessie/config'
import {
  attributionFromActorContext,
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
import { runInferenceGraph } from '../inference.js'
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

/**
 * How this run calls the model. One construction point for every inference the
 * run makes — the main turn, delegate sub-agents, compaction and checkpoint
 * notes — so all of them carry identical routing, credentials, and signed
 * attribution. Only the model id and the streaming callbacks differ.
 */
export type RunInference = {
  /** True when the current main turn already streamed text to the thread. */
  consumeStreamedFlag: () => boolean
  runMain: (
    messages: ProviderMessage[],
    tools: ToolSchemaDescriptor[],
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

  const call = async (
    messages: ProviderMessage[],
    tools: ToolSchemaDescriptor[],
    agentModel: { model: string | null; provider: string | null },
    streaming: boolean,
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
        maxOutputTokensOverride: composeAvailable
          ? resolveComposeOutputTokens(runtimeModelConfig.maxTokens)
          : undefined,
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
    runMain: (messages, tools) => {
      currentTurnStreamed = false
      return call(messages, tools, runModel, true)
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
