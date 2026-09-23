import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UOA_SUBJECT_FORBIDDEN_CODE,
  UoaDelegatedIdentityError,
  classifyUoaExchangeFailure,
  exchangeUoaDelegation,
  type UoaExchangeFailure,
  type UoaExchangeFetch,
} from '../src/uoa-delegation-exchange.js'

const settings = {
  authBaseUrl: 'https://authentication.unlikeotherai.com',
  clientSecret: 'client-secret',
  configUrl: 'https://api.nessie.works/api/auth/sso/config',
  sourceDomain: 'api.nessie.works',
}

const token = (claims: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

const exchange = (fetchImpl: UoaExchangeFetch) => exchangeUoaDelegation(settings, fetchImpl, {
  subjectToken: 'assertion',
  scope: 'ai.invoke',
  audience: 'https://ledger.unlikeotherai.com',
  tokenVersion: 7,
  nowSeconds: 2_000_000_000,
  fallbackTtlSeconds: 300,
})

const failureOf = async (fetchImpl: UoaExchangeFetch): Promise<UoaExchangeFailure | null> => {
  try {
    await exchange(fetchImpl)
  } catch (error) {
    assert.ok(error instanceof UoaDelegatedIdentityError)
    assert.equal(error.code, 'UOA_TOKEN_EXCHANGE_FAILED')
    return error.exchangeFailure
  }
  assert.fail('the exchange succeeded')
}

const answering = (status: number, body: unknown): UoaExchangeFetch =>
  (async () => new Response(JSON.stringify(body), { status })) as UoaExchangeFetch

test('a delegation bound to the asserted epoch is returned with its own expiry', async () => {
  const issued = token({ tv: 7, exp: 2_000_000_600 })
  assert.deepEqual(await exchange(answering(200, { access_token: issued, expires_in: 300 })), {
    token: issued,
    expiresAt: 2_000_000_600,
  })
})

test('every failed exchange says what it failed with', async () => {
  // UOA's error body names the code only when it is on its production public
  // list; a body naming none, or not JSON at all, still carries the status.
  assert.deepEqual(
    await failureOf(answering(403, { error: 'Request failed', code: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' })),
    { kind: 'refused', status: 403, code: 'TOKEN_EXCHANGE_SUBJECT_FORBIDDEN' },
  )
  assert.deepEqual(await failureOf(answering(403, { error: 'Request failed' })), {
    kind: 'refused', status: 403, code: null,
  })
  assert.deepEqual(
    await failureOf((async () => new Response('<html>', { status: 403 })) as UoaExchangeFetch),
    { kind: 'refused', status: 403, code: null },
  )
  assert.deepEqual(await failureOf(answering(403, { code: 'not a code' })), { kind: 'refused', status: 403, code: null })
  assert.deepEqual(await failureOf(answering(503, {})), { kind: 'refused', status: 503, code: null })
  assert.deepEqual(
    await failureOf((async () => { throw new TypeError('fetch failed') }) as UoaExchangeFetch),
    { kind: 'unreachable' },
  )
  assert.deepEqual(await failureOf(answering(200, { expires_in: 300 })), { kind: 'malformed' })
  assert.deepEqual(await failureOf(answering(200, { access_token: 'not-a-jwt' })), { kind: 'malformed' })
  assert.deepEqual(await failureOf(answering(200, { access_token: token({ exp: 1 }) })), { kind: 'malformed' })
  assert.deepEqual(
    await failureOf((async () => new Response('<html>', { status: 200 })) as UoaExchangeFetch),
    { kind: 'malformed' },
  )
  assert.deepEqual(await failureOf(answering(200, { access_token: token({ tv: 8 }) })), { kind: 'epoch_mismatch' })
})

test('only a proven refusal of the person is identity drift; only an outage passes', () => {
  const refused = (status: number, code: string | null = null): UoaExchangeFailure =>
    ({ kind: 'refused', status, code })
  const cases: Array<[UoaExchangeFailure | null, ReturnType<typeof classifyUoaExchangeFailure>]> = [
    [refused(403, UOA_SUBJECT_FORBIDDEN_CODE), 'identity'],
    [{ kind: 'epoch_mismatch' }, 'identity'],
    [{ kind: 'unreachable' }, 'transient'],
    [refused(408), 'transient'],
    [refused(429), 'transient'],
    [refused(500), 'transient'],
    [refused(503), 'transient'],
    // Nessie's client, its assertion or its request: no person can fix these.
    [refused(400), 'fault'],
    [refused(401), 'fault'],
    [refused(404), 'fault'],
    // UOA answers 403 for Nessie's own delegation mapping, client domain,
    // resource or scope too, and its production body can hide which: a 403
    // that does not name the subject code must never block or notify anyone.
    [refused(403), 'fault'],
    [refused(403, 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED'), 'fault'],
    [refused(401, UOA_SUBJECT_FORBIDDEN_CODE), 'fault'],
    [{ kind: 'malformed' }, 'fault'],
    [null, 'fault'],
  ]
  for (const [failure, expected] of cases) {
    assert.equal(classifyUoaExchangeFailure(failure), expected, JSON.stringify(failure))
  }
})
