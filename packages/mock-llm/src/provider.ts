import type {
  InferenceResult,
  InvocationRecord,
  ModelProviderName,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import { MockLlmEngine, MockLlmProviderError } from './engine.js'
import type { MockScenario } from './scenario.js'

// In-process adapter: turns a scenario into the exact `runInference` seam the
// worker's agentic loop consumes (`(messages, tools) => Promise<InferenceResult>`).
// Existing tests that hand-stub `runInference` can migrate to this without any
// HTTP or database setup.

export type MockRunInference = (
  messages: ProviderMessage[],
  tools?: ToolSchemaDescriptor[],
) => Promise<InferenceResult>

export type MockRunInferenceOptions = {
  provider?: ModelProviderName
  // Prefix for deterministic request/invocation ids; keep per test for readable
  // assertions. Defaults to the scenario name.
  idPrefix?: string
}

export const createMockRunInference = (
  scenario: MockScenario,
  options: MockRunInferenceOptions = {},
): MockRunInference => {
  const engine = new MockLlmEngine(scenario)
  const provider = options.provider ?? 'openai'
  const idPrefix = options.idPrefix ?? scenario.name
  let sequence = 0

  return async (messages) => {
    const outcome = await engine.next(messages)
    if (outcome.kind === 'error') {
      throw new MockLlmProviderError(outcome.error)
    }

    sequence += 1
    const requestId = `${idPrefix}-req-${sequence}`
    const finishReason =
      outcome.finishReason ?? (outcome.toolCalls.length > 0 ? 'tool-call' : 'stop')
    const invocation: InvocationRecord = {
      finishReason,
      invocationId: `${idPrefix}-inv-${sequence}`,
      latencyMs: outcome.latencyMs,
      model: engine.model,
      operationType: 'chat',
      provider,
      requestId,
      usage: {
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        totalTokens: (outcome.usage.inputTokens ?? 0) + (outcome.usage.outputTokens ?? 0),
      },
    }

    return {
      finishReason,
      invocations: [invocation],
      model: engine.model,
      outputText: outcome.text,
      provider,
      requestId,
      toolCalls: outcome.toolCalls.map((toolCall, index) => ({
        arguments: toolCall.arguments,
        toolCallId: toolCall.toolCallId ?? `${idPrefix}-call-${sequence}-${index}`,
        toolName: toolCall.toolName,
      })),
    }
  }
}
