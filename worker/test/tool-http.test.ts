import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatchTool } from '../src/run/tool-dispatch.js'
import { runHttpTool, type HttpToolEndpoint } from '../src/run/tool-http.js'

type FetchCall = { url: string; init: RequestInit }

const makeFakeFetch = (
  respond: (url: string, init: RequestInit) => Response,
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init: init ?? {} })
    return respond(url, init ?? {})
  }
  return { fetchImpl, calls }
}

test('runHttpTool injects bearer auth and forwards JSON body', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  const endpoint: HttpToolEndpoint = {
    method: 'POST',
    url: 'https://example.com/api',
    auth: { kind: 'bearer' },
  }
  const result = await runHttpTool({
    endpoint,
    args: { hello: 'world' },
    secret: 'sek',
    fetchImpl,
  })
  assert.equal(result.status, 200)
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.init.method, 'POST')
  const headers = call.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sek')
  assert.equal(call.init.body, JSON.stringify({ hello: 'world' }))
})

test('runHttpTool injects apiKey auth with custom header and prefix', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))
  await runHttpTool({
    endpoint: {
      method: 'GET',
      url: 'https://example.com',
      auth: { kind: 'apiKey', headerName: 'X-Custom', valuePrefix: 'Key ' },
    },
    args: undefined,
    secret: 'abc',
    fetchImpl,
  })
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers['X-Custom'], 'Key abc')
})

test('runHttpTool skips auth header when no secret is provided', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))
  await runHttpTool({
    endpoint: {
      method: 'GET',
      url: 'https://example.com',
      auth: { kind: 'apiKey', headerName: 'X-API-Key' },
    },
    args: undefined,
    secret: null,
    fetchImpl,
  })
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers['X-API-Key'], undefined)
})

test('runHttpTool omits body for GET requests even when args are provided', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))
  await runHttpTool({
    endpoint: { method: 'GET', url: 'https://example.com' },
    args: { ignored: true },
    secret: null,
    fetchImpl,
  })
  assert.equal(calls[0]!.init.body, undefined)
})

test('dispatchTool routes http transport and marks 2xx as success', async () => {
  const { fetchImpl } = makeFakeFetch(() =>
    new Response('accepted', { status: 202, headers: { 'content-type': 'text/plain' } }),
  )
  const result = await dispatchTool({
    spec: {
      transport: 'http',
      endpoint: { method: 'GET', url: 'https://example.com' },
    },
    args: undefined,
    httpFetchImpl: fetchImpl,
  })
  assert.equal(result.success, true)
  assert.equal(result.output, 'accepted')
})

test('dispatchTool reports non-2xx http responses as success=false', async () => {
  const { fetchImpl } = makeFakeFetch(() =>
    new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
  )
  const result = await dispatchTool({
    spec: {
      transport: 'http',
      endpoint: { method: 'GET', url: 'https://example.com' },
    },
    args: undefined,
    httpFetchImpl: fetchImpl,
  })
  assert.equal(result.success, false)
  assert.equal(result.output, 'unavailable')
})
