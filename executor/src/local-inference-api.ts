import type {
  LocalInferenceAttemptRequest,
  LocalInferenceResult,
  LocalInferenceSignedEnvelope,
  ObservedLocalModel,
} from '@nessie/schemas'

const REQUEST_TIMEOUT_MS = 25_000

type ApiEnvelopeRequest<TName extends string, TBody> = Record<TName, TBody> & {
  envelope: LocalInferenceSignedEnvelope
}

export type LocalInferenceAttemptLease = {
  attempt: LocalInferenceAttemptRequest | null
  dispatchFence: number | null
}

export type LocalInferenceFrame = {
  attemptId: string
  data: string
  dispatchFence: number
  sequence: number
}

export type LocalInferenceResultReceipt = {
  attemptId: string
  dispatchFence: number
  result: LocalInferenceResult
}

export type LocalInferenceDaemonApi = {
  heartbeat: (
    input: ApiEnvelopeRequest<'heartbeat', { inventory: ObservedLocalModel[]; paused: boolean }>,
  ) => Promise<{ serverTime: string }>
  poll: (input: ApiEnvelopeRequest<'poll', Record<string, never>>) => Promise<LocalInferenceAttemptLease>
  submitFrame: (input: ApiEnvelopeRequest<'frame', LocalInferenceFrame>) => Promise<{ acknowledged: true }>
  submitResult: (input: ApiEnvelopeRequest<'receipt', LocalInferenceResultReceipt>) => Promise<{ acknowledged: true }>
}

export class LocalInferenceApiError extends Error {
  override readonly name = 'LocalInferenceApiError'

  constructor(readonly code: string, readonly status?: number) {
    super(code)
  }
}

const endpoint = (baseUrl: string, path: string): string => {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:') throw new Error('Local inference requires an HTTPS API origin.')
  return new URL(path, base).toString()
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const responseData = <T>(value: unknown): T => {
  const record = asRecord(value)
  if (record?.data === undefined) {
    const error = asRecord(record?.error)
    throw new LocalInferenceApiError(typeof error?.code === 'string' ? error.code : 'LOCAL_INFERENCE_API_INVALID')
  }
  return record.data as T
}

/**
 * Typed transport for the inference daemon only. It intentionally exposes no
 * method/path/header supplied by model data, and it rejects a non-TLS API
 * origin before a request can leave the device.
 */
export const createLocalInferenceDaemonApi = (input: {
  apiBaseUrl: string
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}): LocalInferenceDaemonApi => {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Local inference request timeout is invalid.')

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpoint(input.apiBaseUrl, path), {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        throw new LocalInferenceApiError('LOCAL_INFERENCE_API_INVALID', response.status)
      }
      if (!response.ok) {
        const payload = asRecord(parsed)
        const error = asRecord(payload?.error)
        throw new LocalInferenceApiError(
          typeof error?.code === 'string' ? error.code : 'LOCAL_INFERENCE_API_FAILED',
          response.status,
        )
      }
      return responseData<T>(parsed)
    } catch (error) {
      if (error instanceof LocalInferenceApiError) throw error
      if (controller.signal.aborted) throw new LocalInferenceApiError('LOCAL_INFERENCE_API_TIMEOUT')
      throw new LocalInferenceApiError('LOCAL_INFERENCE_API_UNREACHABLE')
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    heartbeat: (body) => post('/api/local-inference/daemon/heartbeat', body),
    poll: (body) => post('/api/local-inference/daemon/attempts/poll', body),
    submitFrame: (body) => post('/api/local-inference/daemon/attempts/frame', body),
    submitResult: (body) => post('/api/local-inference/daemon/attempts/result', body),
  }
}
