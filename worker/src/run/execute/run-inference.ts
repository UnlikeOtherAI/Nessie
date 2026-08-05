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
import { runInferenceGraph } from '../inference.js'
import { createProviderRequestHeadersResolver } from '../inference-identity.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import type { UtilityModel } from './utility-model.js'
import type { BudgetModelOverride, ExecutionDependencies, RunContext } from './types.js'

const runtimeModelConfig = loadConfig().model

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
    const mpr = await runInferenceGraph(deps.prisma, {
      actorContext: payload.actorContext,
      agent: {
        id: context.agent.id,
        model: agentModel.model,
        provider: agentModel.provider,
        routingProfileId: null,
      },
      baseMessages: messages,
      modelConfig: runtimeModelConfig,
      onVisibleReasoningDelta: async (chunk) => {
        if (!streaming) return
        await options.thinkingRecorder.appendReasoning(chunk)
      },
      onVisibleTextDelta: async (chunk) => {
        if (!streaming) return
        currentTurnStreamed = true
        await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
          content: chunk,
          runId: parseRunId(context.run.id),
        })
      },
      organizationId: context.channel.organizationId,
      reasoningEffort,
      requestHeadersForProvider,
      // Note/compaction calls carry no tools at all; providers reject an empty
      // tool array, so the whole tool block is omitted instead.
      ...(tools.length > 0 ? { toolChoice: 'auto' as const, tools } : {}),
    })
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
