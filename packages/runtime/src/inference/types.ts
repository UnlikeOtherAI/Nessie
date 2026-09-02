import type { AuthorizedActionContext, ProviderReasoningEffort } from '@nessie/schemas'

export type ModelProviderName =
  | 'openai'
  | 'kimi'
  | 'deepseek'
  | 'openai-compatible'
  /**
   * ChatGPT's Codex backend, reached with a person's own subscription grant.
   * It speaks the Responses API rather than chat/completions, which is why it
   * is a provider of its own instead of another `openai-compatible` base URL.
   */
  | 'codex-subscription'

export type ModelProviderConfig = {
  apiKey?: string
  baseUrl?: string
  modelName?: string
  provider: ModelProviderName
  /** Ledger adapter id; defaults to provider for built-in connectors. */
  serviceId?: string
  /**
   * Extra request headers a provider adapter requires beyond bearer auth (xAI's
   * `X-XAI-Token-Auth`, ChatGPT's account id). Supplied only by code-declared
   * adapters — never by a caller, a model, or a stored record — so this can
   * never become a way to steer a request somewhere else.
   */
  extraHeaders?: Record<string, string>
}

export type ProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unreachable'
  | 'unknown'

export type ToolCallingMode = 'native' | 'prompt-translated' | 'disabled'
export type StructuredOutputMode = 'native-json' | 'prompt-json' | 'text-only'
export type SystemPromptMode = 'native' | 'fold-into-user'
export type ToolResultMode = 'native-tool-message' | 'context-block'

export type NormalizedFinishReason =
  | 'stop'
  | 'length'
  | 'tool-call'
  | 'content-filter'
  | 'error'
  | 'other'

export type JsonObjectResponseFormat = {
  type: 'json_object'
}

export type ToolSchemaDescriptor = {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ProviderToolCall = {
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}

/**
 * An image riding along with a user turn so a vision-capable model can actually
 * look at it. The bytes are inlined rather than referenced by URL: attachment
 * bytes are private to the workspace and no provider can fetch them.
 *
 * Connectors whose model cannot take images drop these and send the text alone
 * — the turn still names its attachments, so the model knows they exist.
 */
export type ProviderImage = {
  mime: string
  dataBase64: string
}

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ProviderImage[] }
  | { role: 'assistant'; content: string | null; toolCalls?: ProviderToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string }

export type UsageReporting = {
  cacheReadTokens: boolean
  cacheWriteTokens: boolean
  cachedInputTokens: boolean
  cachedOutputTokens: boolean
  inputTokens: boolean
  outputTokens: boolean
  providerReportedCost: boolean
}

export type ModelCapabilitySnapshot = {
  provider: ModelProviderName
  model: string
  displayName?: string
  supportsChat: boolean
  supportsEmbeddings: boolean
  supportsModelDiscovery: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  structuredOutputMode: StructuredOutputMode
  systemPromptMode: SystemPromptMode
  toolCallingMode: ToolCallingMode
  toolResultMode: ToolResultMode
  usageReporting: UsageReporting
  maxInputTokens?: number
  maxOutputTokens?: number
  source: 'static' | 'live' | 'manual'
  discoveredAt: string
  lastVerifiedAt?: string
}

export type CapabilityResolution = {
  effectiveSnapshot: ModelCapabilitySnapshot
  effectiveSource: 'manual' | 'static'
  overrideActive: boolean
}

export type InvocationUsage = {
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cachedInputTokens?: number
  cachedOutputTokens?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type InvocationRecord = {
  invocationId: string
  requestId: string
  correlationId?: string
  provider: ModelProviderName
  model: string
  operationType: 'chat' | 'completion' | 'embedding' | 'other'
  usage: InvocationUsage
  providerReportedCost?: { amount: number; currency: string }
  latencyMs: number
  finishReason?: NormalizedFinishReason
  metadata?: Record<string, unknown>
}

export type ProviderInvocationRequest = {
  requestId: string
  correlationId?: string
  messages: ProviderMessage[]
  maxOutputTokens?: number
  metadata?: Record<string, unknown>
  requestHeaders?: Record<string, string>
  model: string
  // Stable key grouping requests that share a prefix (system prompt + tools), so
  // providers route them to the same prompt cache for higher hit rates.
  promptCacheKey?: string
  // Only sent to the provider when set; OpenAI-compatible connectors add it to
  // the request body as `reasoning_effort`. Other providers ignore it.
  reasoningEffort?: ProviderReasoningEffort
  responseFormat?: JsonObjectResponseFormat
  // Aborts the in-flight HTTP request. A caller that passes one must classify
  // the resulting error as an abort rather than a transient failure: retrying a
  // deliberately cancelled call would re-run the work the user just stopped.
  signal?: AbortSignal
  temperature?: number
  tools?: ToolSchemaDescriptor[]
  toolChoice?:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } }
}

export type ProviderInvocationResult = {
  finishReason?: NormalizedFinishReason
  invocation: InvocationRecord
  outputText: string
  toolCalls: ProviderToolCall[]
}

export type ProviderStreamEvent =
  | { type: 'reasoning_text.delta'; text: string }
  | { type: 'output_text.delta'; text: string }
  // `id`/`toolName` come from the connector's accumulated call, not from the
  // chunk that carried this fragment: the canonical OpenAI stream announces the
  // name in a first chunk with empty arguments (which yields no event at all),
  // and every later fragment carries only an index and argument text.
  | { type: 'tool_call.delta'; index: number; id: string; toolName: string; text: string }
  | { type: 'response.error'; message: string; retryable: boolean }

export type ProviderEmbeddingRequest = {
  requestId: string
  correlationId?: string
  input: string
  metadata?: Record<string, unknown>
  requestHeaders?: Record<string, string>
  model?: string
}

export type ProviderEmbeddingResult = {
  embedding: number[]
  invocation: InvocationRecord
}

export type ProviderEmbeddingBatchRequest = {
  requestId: string
  correlationId?: string
  input: string[]
  metadata?: Record<string, unknown>
  requestHeaders?: Record<string, string>
  model?: string
}

export type ProviderEmbeddingBatchResult = {
  embeddings: number[][]
  invocation: InvocationRecord
}

export type ProviderHealthReport = {
  status: ProviderHealthStatus
  checkedAt: string
  latencyMs?: number
  message?: string
}

export interface ProviderConnector {
  readonly provider: ModelProviderName
  checkHealth(): Promise<ProviderHealthReport>
  close(): void
  embed?(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult>
  embedBatch?(request: ProviderEmbeddingBatchRequest): Promise<ProviderEmbeddingBatchResult>
  fetchCompletion(
    body: Record<string, unknown>,
    requestHeaders?: Record<string, string>,
  ): Promise<Response>
  getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot>
  getProviderMeta(): Promise<{
    displayName: string
    provider: ModelProviderName
    supportsModelDiscovery: boolean
  }>
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>
  listModels(): Promise<ModelCapabilitySnapshot[]>
  stream?(
    request: ProviderInvocationRequest,
  ): AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined>
}

export type ProviderConnectorFactory = (
  config: ModelProviderConfig,
) => ProviderConnector

export interface ConnectorRegistry {
  getConfigured(config: ModelProviderConfig): ProviderConnector
  listRegistered(): ModelProviderName[]
  register(
    provider: ModelProviderName,
    factory: ProviderConnectorFactory,
  ): void
}

export interface CapabilityCatalog {
  invalidate(provider: ModelProviderName, model?: string): void
  resolve(
    config: ModelProviderConfig,
    model?: string,
  ): Promise<CapabilityResolution>
}

export type InferenceRequest = {
  actorContext?: AuthorizedActionContext
  correlationId?: string
  maxOutputTokens?: number
  /** Aborts the in-flight provider call; see ProviderInvocationRequest.signal. */
  signal?: AbortSignal
  messages: ProviderMessage[]
  metadata?: Record<string, unknown>
  model?: string
  promptCacheKey?: string
  reasoningEffort?: ProviderReasoningEffort
  requestId?: string
  requestHeaders?: Record<string, string>
  responseFormat?: JsonObjectResponseFormat
  temperature?: number
  tools?: ToolSchemaDescriptor[]
  toolChoice?:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } }
}

export type InferenceResult = {
  correlationId?: string
  finishReason?: NormalizedFinishReason
  invocations: InvocationRecord[]
  model: string
  outputText: string
  provider: ModelProviderName
  requestId: string
  toolCalls: ProviderToolCall[]
}

export type InferenceStreamEvent = ProviderStreamEvent

export type InferenceEmbedRequest = {
  actorContext?: AuthorizedActionContext
  correlationId?: string
  metadata?: Record<string, unknown>
  model?: string
  requestId?: string
  requestHeaders?: Record<string, string>
}

export interface InferenceService {
  checkHealth(): Promise<ProviderHealthReport>
  close(): void
  embed(
    input: string,
    request?: InferenceEmbedRequest,
  ): Promise<ProviderEmbeddingResult>
  embedBatch(
    input: string[],
    request?: InferenceEmbedRequest,
  ): Promise<ProviderEmbeddingBatchResult>
  fetchCompletion(
    body: Record<string, unknown>,
    requestHeaders?: Record<string, string>,
  ): Promise<Response>
  getCapabilities(model?: string): Promise<CapabilityResolution>
  run(request: InferenceRequest): Promise<InferenceResult>
  stream?(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamEvent, InferenceResult, undefined>
}

export type ProviderFailureDetails = {
  creditRefusal?: 'ledger'
  providerCode?: string
  statusCode?: number
}

/**
 * A non-success HTTP response from a model provider. The response's structured
 * status and code are intentionally retained separately from its display
 * message: callers make recovery decisions from protocol facts, never from
 * provider prose.
 */
export class ProviderHttpError extends Error {
  readonly creditRefusal?: 'ledger'
  readonly providerCode?: string
  readonly statusCode: number

  constructor(
    message: string,
    details: ProviderFailureDetails & { statusCode: number },
  ) {
    super(message)
    this.name = 'ProviderHttpError'
    this.creditRefusal = details.creditRefusal
    this.providerCode = details.providerCode
    this.statusCode = details.statusCode
  }
}

export class ProviderInvocationError extends Error {
  readonly creditRefusal?: 'ledger'
  readonly invocation: InvocationRecord
  readonly providerCode?: string
  readonly statusCode?: number

  constructor(
    message: string,
    invocation: InvocationRecord,
    cause?: unknown,
    details: ProviderFailureDetails = {},
  ) {
    super(message)
    this.name = 'ProviderInvocationError'
    this.creditRefusal = details.creditRefusal
    this.invocation = invocation
    this.cause = cause
    this.providerCode = details.providerCode
    this.statusCode = details.statusCode
  }
}

const isProviderFailureDetails = (value: unknown): value is ProviderFailureDetails =>
  typeof value === 'object'
  && value !== null
  && (
    ('statusCode' in value && typeof value.statusCode === 'number')
    || ('providerCode' in value && typeof value.providerCode === 'string')
    || ('creditRefusal' in value && value.creditRefusal === 'ledger')
  )

/** Extract typed provider facts while an error passes through worker layers. */
export const providerFailureDetails = (
  error: unknown,
): ProviderFailureDetails | undefined => {
  if (error instanceof ProviderHttpError || error instanceof ProviderInvocationError) {
    return {
      ...(error.creditRefusal ? { creditRefusal: error.creditRefusal } : {}),
      ...(error.providerCode ? { providerCode: error.providerCode } : {}),
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    }
  }
  return isProviderFailureDetails(error)
    ? {
      ...(error.creditRefusal === 'ledger' ? { creditRefusal: error.creditRefusal } : {}),
      ...(error.providerCode ? { providerCode: error.providerCode } : {}),
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    }
    : undefined
}

/**
 * Ledger's refusal is authoritative for commercial credits. The connector
 * stamps the refusal only when the response came from Ledger; a direct model
 * provider's HTTP 402 is a separate provider-billing problem.
 */
export const isCreditsExhaustedError = (error: unknown): boolean => {
  const details = providerFailureDetails(error)
  return details?.creditRefusal === 'ledger'
}
