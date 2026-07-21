import type { AuthorizedActionContext, ProviderReasoningEffort } from '@nessie/schemas'

export type ModelProviderName = 'openai' | 'minimax' | 'kimi' | 'openai-compatible'

export type ModelProviderConfig = {
  apiKey?: string
  baseUrl?: string
  modelName?: string
  provider: ModelProviderName
  /** Ledger adapter id; defaults to provider for built-in connectors. */
  serviceId?: string
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

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
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
  | { type: 'tool_call.delta'; text: string }
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

export class ProviderInvocationError extends Error {
  readonly invocation: InvocationRecord

  constructor(message: string, invocation: InvocationRecord, cause?: unknown) {
    super(message)
    this.name = 'ProviderInvocationError'
    this.invocation = invocation
    this.cause = cause
  }
}
