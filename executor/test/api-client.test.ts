import assert from 'node:assert/strict'
import test from 'node:test'

import { createExecutorApi, ExecutorApiError } from '../src/api-client.js'

const hangingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  if (!signal) {
    reject(new Error('missing abort signal'))
    return
  }
  const abort = () => reject(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
})

test('client-recovery: every executor API request has a bounded deadline', async () => {
  const client = createExecutorApi({ fetchImpl: hangingFetch, requestTimeoutMs: 10 })
  await assert.rejects(
    client.issueChallenge('https://api.example.test', 'executor'),
    (error: unknown) => (
      error instanceof ExecutorApiError
      && error.code === 'EXECUTOR_API_TIMEOUT'
      && error.message === 'Executor API request timed out.'
    ),
  )
})

test('client-recovery: daemon shutdown cancels pending executor API requests', async () => {
  const client = createExecutorApi({ fetchImpl: hangingFetch, requestTimeoutMs: 10_000 })
  const request = client.issueChallenge('https://api.example.test', 'executor')
  client.cancelPending()
  await assert.rejects(
    request,
    (error: unknown) => (
      error instanceof ExecutorApiError
      && error.code === 'EXECUTOR_API_CANCELLED'
      && error.message === 'Executor API request was cancelled.'
    ),
  )
})

test('client-recovery: executor API errors retain their stable server code', async () => {
  const client = createExecutorApi({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'EXECUTOR_COMMAND_REPLAY', message: 'Receipt is out of order.' },
    }), { status: 409 }),
  })
  await assert.rejects(
    client.issueChallenge('https://api.example.test', 'executor'),
    (error: unknown) => (
      error instanceof ExecutorApiError
      && error.code === 'EXECUTOR_COMMAND_REPLAY'
      && error.status === 409
    ),
  )
})
