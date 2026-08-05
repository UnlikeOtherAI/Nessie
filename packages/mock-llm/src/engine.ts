import type { ProviderMessage } from '@nessie/runtime'
import type { MockError, MockScenario, MockStream, MockToolCall, MockUsage } from './scenario.js'

// Deterministic scripted-inference engine. It is shared by the in-process
// provider adapter (unit/integration tests) and the HTTP server (full-pipeline
// smoke/load runs), so every entry point replays the exact same conversation.

export type MockCompletionTurn = {
  finishReason?: 'stop' | 'length' | 'tool-call' | 'content-filter' | 'error' | 'other'
  kind: 'completion'
  latencyMs: number
  // Visible reasoning emitted ahead of the answer on streamed turns.
  reasoning?: string
  stream?: MockStream
  text: string
  toolCalls: MockToolCall[]
  turnIndex: number
  usage: MockUsage
}

export type MockErrorTurn = {
  error: MockError
  kind: 'error'
  turnIndex: number
}

export type MockTurnOutcome = MockCompletionTurn | MockErrorTurn

export class MockScenarioExhaustedError extends Error {
  constructor(scenarioName: string, turnIndex: number) {
    super(
      `Mock-LLM scenario "${scenarioName}" has no scripted turn ${turnIndex} `
      + `(it defines ${turnIndex} turns). The conversation ran longer than scripted.`,
    )
    this.name = 'MockScenarioExhaustedError'
  }
}

// Thrown by the in-process provider adapter for scripted failure turns; shaped
// like the error a real provider client surfaces for 429/5xx/auth responses.
export class MockLlmProviderError extends Error {
  readonly code: string | null
  readonly status: number
  readonly type: string

  constructor(error: MockError) {
    super(`mock-llm provider error ${error.status}: ${error.message}`)
    this.name = 'MockLlmProviderError'
    this.code = error.code
    this.status = error.status
    this.type = error.type
  }
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

// The next scripted turn is derived from the conversation itself: the number of
// assistant turns already present in the request. This keeps the engine
// stateless per conversation, so any number of concurrent runs replay the same
// scenario without cursors or shared mutable state.
export const turnIndexForMessages = (messages: ProviderMessage[]): number =>
  messages.filter((message) => message.role === 'assistant').length

export type MockEngineStats = {
  requests: number
  turnCounts: Record<number, number>
}

export class MockLlmEngine {
  private requests = 0
  private readonly turnCounts = new Map<number, number>()

  constructor(private readonly scenario: MockScenario) {}

  get scenarioName(): string {
    return this.scenario.name
  }

  get model(): string {
    return this.scenario.defaults.model
  }

  stats(): MockEngineStats {
    return {
      requests: this.requests,
      turnCounts: Object.fromEntries(this.turnCounts),
    }
  }

  async next(messages: ProviderMessage[]): Promise<MockTurnOutcome> {
    const turnIndex = turnIndexForMessages(messages)
    const turn = this.scenario.turns[turnIndex]
    if (!turn) {
      throw new MockScenarioExhaustedError(this.scenario.name, turnIndex)
    }

    this.requests += 1
    this.turnCounts.set(turnIndex, (this.turnCounts.get(turnIndex) ?? 0) + 1)

    if ('error' in turn) {
      await sleep(turn.error.latencyMs)
      return { error: turn.error, kind: 'error', turnIndex }
    }

    const latencyMs = turn.latencyMs + this.scenario.defaults.latencyMs
    await sleep(latencyMs)
    return {
      kind: 'completion',
      latencyMs,
      turnIndex,
      ...(turn.finishReason !== undefined ? { finishReason: turn.finishReason } : {}),
      ...(turn.reasoning !== undefined ? { reasoning: turn.reasoning } : {}),
      ...(turn.stream !== undefined ? { stream: turn.stream } : {}),
      text: turn.text,
      toolCalls: turn.toolCalls,
      usage: turn.usage,
    }
  }
}
