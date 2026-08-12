import type { ExecutorCommandEnvelope, ExecutorCommandReceipt } from '@nessie/schemas'

type ApiError = { error?: { code?: string; message?: string } }

const normalizeUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/$/, '')}${path}`

const post = async <T>(baseUrl: string, path: string, body: unknown): Promise<T> => {
  const response = await fetch(normalizeUrl(baseUrl, path), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const payload = await response.json() as { data?: T } & ApiError
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? `Executor API request failed (${response.status}).`)
  }
  return payload.data
}

export const executorApi = {
  claim: (baseUrl: string, input: { challenge: string; executorId: string; signature: string }) =>
    post<{ connectionEpoch: string; status: string }>(baseUrl, '/api/executor-daemon/claim', input),
  heartbeat: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string },
  ) => post<{ connectionEpoch: string; status: string }>(baseUrl, '/api/executor-daemon/heartbeat', input),
  pollCommand: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string },
  ) => post<{ command: ExecutorCommandEnvelope | null }>(baseUrl, '/api/executor-daemon/commands/poll', input),
  recordCommandReceipt: (
    baseUrl: string,
    input: {
      connectionEpoch: string
      executorId: string
      receipt: ExecutorCommandReceipt
      result?: Record<string, unknown>
      signature: string
    },
  ) => post<{ recorded: boolean }>(baseUrl, '/api/executor-daemon/commands/receipt', input),
  issueChallenge: (baseUrl: string, executorId: string) =>
    post<{ challenge: string; expiresAt: string }>(baseUrl, '/api/executor-daemon/challenge', { executorId }),
  submitDescriptor: (
    baseUrl: string,
    input: { connectionEpoch: string; descriptor: unknown; executorId: string },
  ) => post<{ reviewStatus: string; revision: number }>(baseUrl, '/api/executor-daemon/descriptor', input),
  submitEnrollment: (baseUrl: string, input: unknown) =>
    post<{ executorId: string; fingerprint: string }>(baseUrl, '/api/executor-enrollments/submit', input),
}
