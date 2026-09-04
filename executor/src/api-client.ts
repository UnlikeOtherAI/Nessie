import type { ExecutorCommandEnvelope, ExecutorCommandReceipt } from '@nessie/schemas'

type ApiError = { error?: { code?: string; message?: string } }

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

const normalizeUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/$/, '')}${path}`

export class ExecutorApiError extends Error {
  readonly code?: string
  readonly status?: number

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'ExecutorApiError'
    this.code = options.code
    this.status = options.status
  }
}

export type ExecutorApiClient = {
  cancelPending: () => void
  claim: (baseUrl: string, input: { challenge: string; executorId: string; signature: string }) =>
    Promise<{ connectionEpoch: string; status: string }>
  heartbeat: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string },
  ) => Promise<{ connectionEpoch: string; status: string }>
  pollCommand: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string },
  ) => Promise<{ command: ExecutorCommandEnvelope | null }>
  recordCommandReceipt: (
    baseUrl: string,
    input: {
      connectionEpoch: string
      executorId: string
      receipt: ExecutorCommandReceipt
      result?: Record<string, unknown>
      signature: string
    },
  ) => Promise<{ recorded: boolean }>
  issueChallenge: (baseUrl: string, executorId: string) =>
    Promise<{ challenge: string; expiresAt: string }>
  submitDescriptor: (
    baseUrl: string,
    input: { connectionEpoch: string; descriptor: unknown; executorId: string },
  ) => Promise<{ reviewStatus: string; revision: number }>
  submitEnrollment: (
    baseUrl: string,
    input: unknown,
  ) => Promise<{ executorId: string; fingerprint: string }>
}

export const createExecutorApi = (options: {
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
} = {}): ExecutorApiClient => {
  const fetchImpl = options.fetchImpl ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Executor API request timeout must be positive and finite.')
  }
  const pending = new Set<AbortController>()

  const post = async <T>(baseUrl: string, path: string, body: unknown): Promise<T> => {
    const controller = new AbortController()
    pending.add(controller)
    const timeout = setTimeout(() => controller.abort('deadline'), requestTimeoutMs)
    try {
      const response = await fetchImpl(normalizeUrl(baseUrl, path), {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })
      let payload: { data?: T } & ApiError
      try {
        payload = await response.json() as { data?: T } & ApiError
      } catch {
        throw new ExecutorApiError(`Executor API returned an invalid response (${response.status}).`, {
          status: response.status,
        })
      }
      if (!response.ok || payload.data === undefined) {
        throw new ExecutorApiError(
          payload.error?.message ?? `Executor API request failed (${response.status}).`,
          { code: payload.error?.code, status: response.status },
        )
      }
      return payload.data
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason === 'deadline'
        throw new ExecutorApiError(
          timedOut ? 'Executor API request timed out.' : 'Executor API request was cancelled.',
          { code: timedOut ? 'EXECUTOR_API_TIMEOUT' : 'EXECUTOR_API_CANCELLED' },
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      pending.delete(controller)
    }
  }

  return {
    cancelPending: () => {
      for (const controller of pending) controller.abort('cancelled')
    },
    claim: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/claim', input),
    heartbeat: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/heartbeat', input),
    pollCommand: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/commands/poll', input),
    recordCommandReceipt: (baseUrl, input) =>
      post(baseUrl, '/api/executor-daemon/commands/receipt', input),
    issueChallenge: (baseUrl, executorId) =>
      post(baseUrl, '/api/executor-daemon/challenge', { executorId }),
    submitDescriptor: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/descriptor', input),
    submitEnrollment: (baseUrl, input) => post(baseUrl, '/api/executor-enrollments/submit', input),
  }
}

export const executorApi = createExecutorApi()
