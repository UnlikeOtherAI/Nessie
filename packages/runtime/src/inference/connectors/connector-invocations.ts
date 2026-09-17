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

/** Maximum length of the provider detail snippet carried in the error message. */
const MAX_PROVIDER_ERROR_DETAIL_LENGTH = 240

const REDACTED = '[redacted]'

/**
 * Scrub credential-shaped material from an untrusted provider body before it
 * can reach a persisted message. This is a defensive pass, not a parser: it
 * redacts Authorization headers, bearer tokens, API keys, refresh tokens, JWTs
 * and common key prefixes so a provider's error detail never leaks a secret.
 */
const redactCredentialShape = (text: string): string => {
  if (typeof text !== 'string') return text
  return text
    .replace(/authorization\s*[:=]\s*["']?\s*(?:[Bb]earer\s+)?[A-Za-z0-9_\-\.]+/g, `authorization: ${REDACTED}`)
    .replace(/\b[Bb]earer\s+[A-Za-z0-9_\-\.]{8,}/g, `Bearer ${REDACTED}`)
    .replace(/\b(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{8,}/gi, `api_key: ${REDACTED}`)
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{8,}/gi,
      (_match) => `${_match.split(/[:=]/)[0]?.replace(/["'\s]/g, '') ?? 'token'}: ${REDACTED}`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g, REDACTED)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9]{10,}\b/g, REDACTED)
}

const extractProviderErrorMessage = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const obj = body as Record<string, unknown>
  const candidates: (string | undefined)[] = []
  if (typeof obj.message === 'string') candidates.push(obj.message)
  if (typeof obj.error_description === 'string') candidates.push(obj.error_description)
  if (typeof obj.msg === 'string') candidates.push(obj.msg)
  if (obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)) {
    const error = obj.error as Record<string, unknown>
    if (typeof error.message === 'string') candidates.push(error.message)
    if (typeof error.error_description === 'string') candidates.push(error.error_description)
    if (typeof error.msg === 'string') candidates.push(error.msg)
  }
  const found = candidates.find((candidate) => candidate && candidate.trim().length > 0)
  return found ? found.trim() : undefined
}

const formatProviderErrorDetail = (rawBody: string, body: unknown): string | undefined => {
  const message = extractProviderErrorMessage(body)
  if (message) {
    const redacted = redactCredentialShape(message)
    return redacted.slice(0, MAX_PROVIDER_ERROR_DETAIL_LENGTH).trim()
  }
  const trimmed = rawBody.trim()
  if (!trimmed) return undefined
  const redacted = redactCredentialShape(trimmed)
  return redacted.slice(0, MAX_PROVIDER_ERROR_DETAIL_LENGTH).trim()
}

/**
 * Normalize a provider's non-2xx response. The structured provider code and
 * HTTP status are still the only inputs to recovery decisions, but the
 * persisted error message now carries a bounded, redacted snippet of the
 * provider's explanation so an operator can see why a request was rejected.
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
  const detail = formatProviderErrorDetail(rawBody, body)
  const baseMessage = `${input.provider} ${input.operation} request failed with HTTP ${input.response.status}`
  return new ProviderHttpError(
    detail ? `${baseMessage}: ${detail}` : baseMessage,
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
