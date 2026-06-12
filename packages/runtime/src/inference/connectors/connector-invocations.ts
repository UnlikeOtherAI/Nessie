import { randomUUID } from 'node:crypto'
import { ProviderInvocationError } from '../types.js'
import type {
  InvocationRecord,
  InvocationUsage,
  NormalizedFinishReason,
} from '../types.js'

export const nowIso = (): string => new Date().toISOString()

export const createInvocationRecord = (input: {
  correlationId?: string
  finishReason?: NormalizedFinishReason
  latencyMs: number
  metadata?: Record<string, unknown>
  model: string
  operationType: InvocationRecord['operationType']
  provider: InvocationRecord['provider']
  requestId: string
  usage: InvocationUsage
}): InvocationRecord => ({
  correlationId: input.correlationId,
  finishReason: input.finishReason,
  invocationId: randomUUID(),
  latencyMs: input.latencyMs,
  metadata: input.metadata,
  model: input.model,
  operationType: input.operationType,
  provider: input.provider,
  requestId: input.requestId,
  usage: input.usage,
})

export const providerError = (input: {
  cause: unknown
  correlationId?: string
  latencyMs: number
  metadata?: Record<string, unknown>
  model: string
  operationType: InvocationRecord['operationType']
  provider: InvocationRecord['provider']
  requestId: string
}): ProviderInvocationError => {
  const message = input.cause instanceof Error
    ? input.cause.message
    : 'Provider request failed'

  return new ProviderInvocationError(
    message,
    createInvocationRecord({
      correlationId: input.correlationId,
      finishReason: 'error',
      latencyMs: input.latencyMs,
      metadata: input.metadata,
      model: input.model,
      operationType: input.operationType,
      provider: input.provider,
      requestId: input.requestId,
      usage: {},
    }),
    input.cause,
  )
}
