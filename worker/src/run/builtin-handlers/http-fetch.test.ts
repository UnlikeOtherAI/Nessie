import assert from 'node:assert/strict'
import test from 'node:test'

import { HttpFetchError, runHttpFetch } from './http-fetch.js'

type FetchCall = {
  url: string
  init: RequestInit
}

const makeFakeFetch = (
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const initObj: RequestInit = init ?? {}
    calls.push({ url, init: initObj })
    return responder(url, initObj)
  }
  return { fetchImpl, calls }
}

test('runHttpFetch returns body and headers on happy GET', async () => {
  const { fetchImpl } = makeFakeFetch(() =>
    new Response('hello world', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
    }),
  )

  const result = await runHttpFetch(
    { url: 'https://example.com/data' },
    { fetchImpl },
  )

  assert.equal(result.status, 200)
  assert.equal(result.statusText, 'OK')
  assert.equal(result.bodyText, 'hello world')
  assert.equal(result.truncated, false)
  assert.equal(result.headers['content-type'], 'text/plain')
})

test('runHttpFetch encodes object body as JSON and sets content-type', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('{}', { status: 200 }))

  await runHttpFetch(
    {
      method: 'POST',
      url: 'https://example.com/api',
      body: { hello: 'world' },
    },
    { fetchImpl },
  )

  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.body, JSON.stringify({ hello: 'world' }))
  const headers = call.init.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json')
})

test('runHttpFetch caps response body when maxBytes exceeded', async () => {
  const bigBody = 'x'.repeat(2000)
  const { fetchImpl } = makeFakeFetch(() => new Response(bigBody, { status: 200 }))

  const result = await runHttpFetch(
    { url: 'https://example.com', maxBytes: 100 },
    { fetchImpl },
  )

  assert.equal(result.truncated, true)
  assert.equal(result.bytesRead, 100)
  assert.equal(result.bodyText.length, 100)
})

test('runHttpFetch refuses redirects to file:// URLs', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('', {
      status: 302,
      headers: { location: 'file:///etc/passwd' },
    })

  await assert.rejects(
    runHttpFetch({ url: 'https://example.com' }, { fetchImpl }),
    (err) =>
      err instanceof HttpFetchError &&
      err.message.includes('file://'),
  )
})

test('runHttpFetch injects bearer auth header by default', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))

  await runHttpFetch(
    {
      url: 'https://example.com',
      auth: { kind: 'bearer', token: 'sekret' },
    },
    { fetchImpl },
  )

  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sekret')
})

test('runHttpFetch supports apiKey auth with custom header + prefix', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))

  await runHttpFetch(
    {
      url: 'https://example.com',
      auth: {
        kind: 'apiKey',
        headerName: 'X-Vendor-Token',
        valuePrefix: 'Token ',
        token: 'abc123',
      },
    },
    { fetchImpl },
  )

  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers['X-Vendor-Token'], 'Token abc123')
})

test('runHttpFetch enforces timeoutMs by aborting the request', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal
    return new Promise<Response>((resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new Error('aborted'))
        })
      }
      // never resolves on its own
      setTimeout(() => resolve(new Response('late')), 5_000).unref?.()
    })
  }

  await assert.rejects(
    runHttpFetch(
      { url: 'https://example.com', timeoutMs: 5 },
      { fetchImpl },
    ),
  )
})
