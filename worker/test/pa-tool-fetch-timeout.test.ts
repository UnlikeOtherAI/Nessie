import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * The pa-tools Google fetches must carry a timeout signal into safeFetch.
 *
 * safeFetch sets no default timeout, and the batch's tool timeout only races
 * the call from the loop's side — so a Gmail/Calendar endpoint that accepts
 * the connection and then stalls would hold its socket against the worker's
 * pool indefinitely while the loop reports a timeout and possibly retries a
 * mutating call that later completes. Each pa-tools wrapper now merges
 * `AbortSignal.timeout` into the caller's init (the content-tools web-fetch
 * precedent); these tests drive the real wrappers with a stubbed safeFetch
 * and watch the signal fire.
 *
 * safeFetch itself pins real sockets, so it is stubbed through a module
 * loader — the same passthrough-facade pattern as
 * api/test/auth-login-team-target-fixture.ts: everything re-exports from the
 * built runtime and only the egress helpers are swapped.
 */
const runtimeDistUrl = new URL('../../packages/runtime/dist/index.js', import.meta.url).href
const runtimeStub = [
  `export * from ${JSON.stringify(runtimeDistUrl)}`,
  'export const safeFetch = (url, init, options) => globalThis.__nessieSafeFetchStub(url, init, options)',
  'export const pinnedFetch = (url, init, options) => globalThis.__nessieSafeFetchStub(url, init, options)',
].join('\n')
const runtimeStubUrl = `data:text/javascript,${encodeURIComponent(runtimeStub)}`
const moduleLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@nessie/runtime') {
    return { shortCircuit: true, url: ${JSON.stringify(runtimeStubUrl)} }
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(moduleLoader)}`, import.meta.url)

const stubResponse = {
  body: null,
  headers: new Headers(),
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}

type CapturedCall = { init?: RequestInit; url: unknown }

/**
 * Answer as a provider that accepted the connection and then stalled: settle
 * only when the request's signal aborts. The fallback timer bounds the wait
 * so a wrapper that hands over NO signal (the pre-fix shape) fails the
 * assertion instead of hanging the file.
 */
const installSafeFetchStub = (): CapturedCall[] => {
  const calls: CapturedCall[] = []
  ;(globalThis as Record<string, unknown>).__nessieSafeFetchStub = (
    url: unknown,
    init?: RequestInit,
  ) => {
    calls.push({ init, url })
    return new Promise((resolve, reject) => {
      const fallback = setTimeout(() => resolve(stubResponse), 500)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(fallback)
        reject(init.signal?.reason)
      })
    })
  }
  return calls
}

const { calendarFetch } = await import('../src/run/pa-tools/calendar-tools.js')
const { gmailFetch } = await import('../src/run/pa-tools/gmail-tools.js')
const { googleFetch } = await import('../src/run/pa-tools/gmail-organise-tools.js')

const wrappers = { calendarFetch, gmailFetch, googleFetch } as const

for (const [name, fetchImpl] of Object.entries(wrappers)) {
  test(`${name} merges a firing timeout signal into the caller's init`, async () => {
    const calls = installSafeFetchStub()
    await assert.rejects(
      fetchImpl(
        'https://www.googleapis.com/stalled',
        { body: '{}', headers: { authorization: 'Bearer token' }, method: 'POST' },
        25,
      ),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    )

    const init = calls[0]?.init
    // The caller's init survives the merge untouched...
    assert.equal(init?.method, 'POST')
    assert.equal(init?.body, '{}')
    assert.deepEqual(init?.headers, { authorization: 'Bearer token' })
    // ...and the signal the stalled request was hanging on is what ended it.
    assert.ok(init?.signal instanceof AbortSignal, 'safeFetch must receive a signal')
    assert.equal(init?.signal?.aborted, true)
  })
}
