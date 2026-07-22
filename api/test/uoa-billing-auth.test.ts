import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confirmUoaDirectServiceAccess,
  UoaBillingError,
} from '../src/services/uoa-billing-client.js'
import { getUoaBillingStatement } from '../src/services/uoa-billing-statement.js'
import {
  actorContext,
  env,
  prisma,
  subjectBody,
} from './uoa-billing-statement-fixtures.js'

test('preserves UOA actor 401 for one session renewal while keeping 403 forbidden', async () => {
  for (const expected of [
    { code: 'UOA_BILLING_REAUTH_REQUIRED', status: 401 },
    { code: 'UOA_BILLING_FORBIDDEN', status: 403 },
  ] as const) {
    await assert.rejects(
      getUoaBillingStatement(
        prisma() as never,
        actorContext as never,
        undefined,
        {
          env,
          fetchImpl: (async () => new Response(null, {
            status: expected.status,
          })) as typeof fetch,
        },
      ),
      (error: unknown) =>
        error instanceof UoaBillingError
        && error.code === expected.code
        && error.statusCode === expected.status,
    )
  }
})

test('confirms direct Nessie access only through the exact 204 no-store seam', async () => {
  let requestUrl = ''
  let requestBody: unknown
  const result = confirmUoaDirectServiceAccess({
    organizationId: 'uoa-org',
    teamId: 'uoa-team',
    tokenVersion: 7,
    userId: 'uoa-user',
  }, {
    env,
    fetchImpl: (async (input, init) => {
      requestUrl = input.toString()
      requestBody = JSON.parse(String(init?.body)) as unknown
      return new Response(null, {
        headers: { 'Cache-Control': 'private, no-store' },
        status: 204,
      })
    }) as typeof fetch,
  })
  await assert.doesNotReject(result)
  assert.equal(
    requestUrl,
    'https://uoa.example/billing/v1/service-access/confirm',
  )
  assert.deepEqual(requestBody, subjectBody)

  await assert.rejects(
    confirmUoaDirectServiceAccess({
      organizationId: 'uoa-org',
      teamId: 'uoa-team',
      tokenVersion: 7,
      userId: 'uoa-user',
    }, {
      env,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true }))) as typeof fetch,
    }),
    (error: unknown) =>
      error instanceof UoaBillingError
      && error.code === 'UOA_BILLING_RESPONSE_INVALID',
  )
})
