import { randomUUID } from 'node:crypto'
import { createCapabilityCatalog } from './catalog.js'
import { createConnectorRegistry } from './connectors.js'
import type {
  CapabilityCatalog,
  ConnectorRegistry,
  InferenceRequest,
  InferenceResult,
  InferenceService,
  InferenceStreamEvent,
  ModelProviderConfig,
  ProviderEmbeddingBatchResult,
  ProviderEmbeddingResult,
  ProviderInvocationRequest,
} from './types.js'

type InferenceServiceOptions = {
  capabilityCatalog?: CapabilityCatalog
  registry?: ConnectorRegistry
  requestIdFactory?: () => string
}

const buildRequestId = (
  request: Pick<InferenceRequest, 'actorContext' | 'requestId'>,
  requestIdFactory: () => string,
): string => request.requestId
  ?? request.actorContext?.actionContext.requestId
  ?? requestIdFactory()

const buildCorrelationId = (
  request: Pick<InferenceRequest, 'actorContext' | 'correlationId'>,
): string | undefined => request.correlationId
  ?? request.actorContext?.actionContext.correlationId

const buildProviderRequest = (
  request: InferenceRequest,
  requestId: string,
  model: string,
): ProviderInvocationRequest => ({
  correlationId: buildCorrelationId(request),
  maxOutputTokens: request.maxOutputTokens,
  messages: request.messages,
  metadata: request.metadata,
  model,
  promptCacheKey: request.promptCacheKey,
  requestId,
  responseFormat: request.responseFormat,
  temperature: request.temperature,
  toolChoice: request.toolChoice,
  tools: request.tools,
})

const buildInferenceResult = (
  provider: ModelProviderConfig['provider'],
  model: string,
  result: {
    correlationId?: string
    finishReason?: InferenceResult['finishReason']
    invocations: InferenceResult['invocations']
    outputText: string
    requestId: string
    toolCalls: InferenceResult['toolCalls']
  },
): InferenceResult => ({
  correlationId: result.correlationId,
  finishReason: result.finishReason,
  invocations: result.invocations,
  model,
  outputText: result.outputText,
  provider,
  requestId: result.requestId,
  toolCalls: result.toolCalls,
})

export const createInferenceService = (
  config: ModelProviderConfig,
  options: InferenceServiceOptions = {},
): InferenceService => {
  const registry = options.registry ?? createConnectorRegistry()
  const capabilityCatalog = options.capabilityCatalog ?? createCapabilityCatalog(registry)
  const requestIdFactory = options.requestIdFactory ?? randomUUID
  const connector = registry.getConfigured(config)

  const run: InferenceService['run'] = async (
    request: InferenceRequest,
  ): Promise<InferenceResult> => {
    const requestId = buildRequestId(request, requestIdFactory)
    const capabilities = await capabilityCatalog.resolve(config, request.model)
    const model = request.model ?? capabilities.effectiveSnapshot.model
    const providerRequest = buildProviderRequest(
      capabilities.effectiveSnapshot.toolCallingMode === 'disabled'
        ? { ...request, toolChoice: undefined, tools: undefined }
        : request,
      requestId,
      model,
    )
    const providerResult = await connector.invoke(providerRequest)
    const resolvedModel = providerResult.invocation.model

    return buildInferenceResult(config.provider, resolvedModel, {
      correlationId: providerResult.invocation.correlationId,
      finishReason: providerResult.finishReason,
      invocations: [providerResult.invocation],
      outputText: providerResult.outputText,
      requestId,
      toolCalls: providerResult.toolCalls,
    })
  }

  const stream: NonNullable<InferenceService['stream']> = async function* (
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamEvent, InferenceResult, undefined> {
    if (!connector.stream) {
      const result = await run(request)
      if (result.outputText) {
        yield { type: 'output_text.delta', text: result.outputText }
      }
      return result
    }

    const requestId = buildRequestId(request, requestIdFactory)
    const capabilities = await capabilityCatalog.resolve(config, request.model)
    const model = request.model ?? capabilities.effectiveSnapshot.model
    const providerRequest = buildProviderRequest(
      capabilities.effectiveSnapshot.toolCallingMode === 'disabled'
        ? { ...request, toolChoice: undefined, tools: undefined }
        : request,
      requestId,
      model,
    )
    const providerStream = connector.stream(providerRequest)

    let next = await providerStream.next()
    while (!next.done) {
      yield next.value
      next = await providerStream.next()
    }

    const resolvedModel = next.value.invocation.model

    return buildInferenceResult(config.provider, resolvedModel, {
      correlationId: next.value.invocation.correlationId,
      finishReason: next.value.finishReason,
      invocations: [next.value.invocation],
      outputText: next.value.outputText,
      requestId,
      toolCalls: next.value.toolCalls,
    })
  }

  return {
    async checkHealth() {
      return connector.checkHealth()
    },

    close(): void {
      connector.close()
    },

    async embed(
      input: string,
      request = {},
    ): Promise<ProviderEmbeddingResult> {
      if (!connector.embed) {
        throw new Error(`${config.provider} does not support embeddings`)
      }

      return connector.embed({
        correlationId: request.correlationId
          ?? request.actorContext?.actionContext.correlationId,
        input,
        metadata: request.metadata,
        model: request.model,
        requestId:
          request.requestId
          ?? request.actorContext?.actionContext.requestId
          ?? requestIdFactory(),
      })
    },

    async embedBatch(
      input: string[],
      request = {},
    ): Promise<ProviderEmbeddingBatchResult> {
      if (!connector.embedBatch) {
        throw new Error(`${config.provider} does not support batch embeddings`)
      }

      return connector.embedBatch({
        correlationId: request.correlationId
          ?? request.actorContext?.actionContext.correlationId,
        input,
        metadata: request.metadata,
        model: request.model,
        requestId:
          request.requestId
          ?? request.actorContext?.actionContext.requestId
          ?? requestIdFactory(),
      })
    },

    async fetchCompletion(body: Record<string, unknown>): Promise<Response> {
      return connector.fetchCompletion(body)
    },

    async getCapabilities(model = config.modelName) {
      return capabilityCatalog.resolve(config, model)
    },

    run,
    stream,
  }
}
