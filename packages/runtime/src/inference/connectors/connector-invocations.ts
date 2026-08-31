import { randomUUID } from 'node:crypto'
import {
  ProviderHttpError,
  ProviderInvocationError,
  providerFailureDetails,
} from '../types.js'
import type {
  InvocationRecord,
  InvocationUsage,
  NormalizedFinishReason,
} from '../types.js'

export const nowIso = (): string => new Date().toISOString()

const providerCodeFromBody = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const body = value as Record<string, unknown>
  if (typeof body.code === 'string') return body.code
  if (typeof body.error !== 'object' || body.error === null || Array.isArray(body.error)) {
    return undefined
  }
  const error = body.error as Record<string, unknown>
  return typeof error.code === 'string'
    ? error.code
    : typeof error.type === 'string'
      ? error.type
      : undefined
}

/**
 * Normalize a provider's non-2xx response without promoting its body text to
 * a control signal or user-visible message. Ledger's structured code remains
 * available to the worker through `ProviderInvocationError`.
 */
export const providerHttpError = async (input: {
  ledgerRouted?: boolean
  operation: string
  provider: string
  response: Response
}): Promise<ProviderHttpError> => {
  const rawBody = await input.response.text()
  let body: unknown
  try {
    body = rawBody ? JSON.parse(rawBody) : undefined
  } catch {
    body = undefined
  }
  const providerCode = providerCodeFromBody(body)
  return new ProviderHttpError(
    `${input.provider} ${input.operation} request failed with HTTP ${input.response.status}`,
    {
      ...(input.ledgerRouted
        && (input.response.status === 402 || providerCode === 'budget_exceeded')
        ? { creditRefusal: 'ledger' as const }
        : {}),
      providerCode,
      statusCode: input.response.status,
    },
  )
}

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
  const details = providerFailureDetails(input.cause)

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
    details,
  )
}
