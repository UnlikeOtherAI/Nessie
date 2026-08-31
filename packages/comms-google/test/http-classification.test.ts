import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GmailApiError } from '../src/errors.js'
import { requestJson, type FetchLike } from '../src/http.js'

const respond = (status: number, body: unknown): FetchLike =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })

const googleError = (reason: string, status = 403): unknown => ({
  error: {
    code: status,
    message: 'something went wrong',
    errors: [{ message: 'x', domain: 'global', reason }],
  },
})

const call = async (status: number, body: unknown): Promise<GmailApiError> => {
  try {
    await requestJson(respond(status, body), 'test.op', 'https://example/x')
  } catch (error) {
    assert.ok(error instanceof GmailApiError)
    return error
  }
  throw new Error('expected a GmailApiError')
}

// Google reuses 403 for rate limiting and for "this token lacks the scope".
// Treating the whole status as retryable meant a scope error looped until the
// job died, so a missing scope could never surface as a request to grant it.
test('403 insufficientPermissions is fatal and flagged as a scope failure', async () => {
  const error = await call(403, googleError('insufficientPermissions'))
  assert.equal(error.retryable, false)
  assert.equal(error.scopeMissing, true)
  assert.equal(error.code, 'insufficientPermissions')
})

test('403 rate-limit reasons stay retryable and are not scope failures', async () => {
  for (const reason of [
    'rateLimitExceeded',
    'userRateLimitExceeded',
    'dailyLimitExceeded',
    'quotaExceeded',
  ]) {
    const error = await call(403, googleError(reason))
    assert.equal(error.retryable, true, `${reason} should retry`)
    assert.equal(error.scopeMissing, false, `${reason} is not a scope failure`)
  }
})

test('an unrecognised 403 reason is fatal rather than retried forever', async () => {
  const error = await call(403, googleError('domainPolicyViolation'))
  assert.equal(error.retryable, false)
  assert.equal(error.scopeMissing, false)
})

test('a 403 with no parseable body is fatal', async () => {
  const error = await call(403, { nothing: 'useful' })
  assert.equal(error.retryable, false)
  assert.equal(error.scopeMissing, false)
})

test('the newer error shape is read from error.status', async () => {
  const error = await call(403, {
    error: { code: 403, message: 'nope', status: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
  })
  assert.equal(error.scopeMissing, true)
  assert.equal(error.retryable, false)
})

test('429 and 5xx remain retryable regardless of reason', async () => {
  assert.equal((await call(429, googleError('rateLimitExceeded', 429))).retryable, true)
  assert.equal((await call(500, {})).retryable, true)
  assert.equal((await call(503, {})).retryable, true)
})

test('401 is fatal', async () => {
  const error = await call(401, { error: { code: 401, message: 'bad token' } })
  assert.equal(error.retryable, false)
  assert.equal(error.scopeMissing, false)
})

test('no token material or prose reason drives classification', async () => {
  // The human message must never decide retry: only the machine reason does.
  const error = await call(403, {
    error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'insufficientPermissions' }] },
  })
  assert.equal(error.retryable, false)
})
