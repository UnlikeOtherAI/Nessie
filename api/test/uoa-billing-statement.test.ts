import assert from 'node:assert/strict'
import {
  createPublicKey,
  verify as verifyBytes,
} from 'node:crypto'
import test from 'node:test'

import {
  NESSIE_UOA_BILLING_APP_KEY_ENV,
  confirmUoaDirectServiceAccess,
  UoaBillingError,
} from '../src/services/uoa-billing-client.js'
import {
  confirmUoaBillingCancellation,
  createUoaBillingCancellationPreview,
  executeUoaBillingHostedAction,
  getUoaBillingStatement,
} from '../src/services/uoa-billing-statement.js'
import {
  actionBody,
  actorContext,
  checkoutTariff,
  env,
  generatedKey,
  prisma,
  statement,
  subjectBody,
} from './uoa-billing-statement-fixtures.js'

const decodeJwtPart = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >

test('binds the canonical statement to Nessie, the team, and a signed actor', async () => {
  let requestUrl = ''
  let requestHeaders = new Headers()
  let requestBody: Record<string, unknown> = {}
  const result = await getUoaBillingStatement(
    prisma() as never,
    actorContext as never,
    '2026-07',
    {
      env,
      now: () => 1_784_570_000,
      randomId: () => 'billing-jti',
      fetchImpl: (async (input, init) => {
        requestUrl = input.toString()
        requestHeaders = new Headers(init?.headers)
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify(statement))
      }) as typeof fetch,
    },
  )

  assert.equal(result.statement_id, 'bst_nessie_july')
  assert.equal(requestUrl, 'https://uoa.example/billing/v2/customer-statement')
  assert.equal(
    requestHeaders.get('x-uoa-app-key'),
    env[NESSIE_UOA_BILLING_APP_KEY_ENV],
  )
  assert.deepEqual(requestBody, { ...subjectBody, billing_month: '2026-07' })

  const actor = requestHeaders.get('x-uoa-actor')
  assert.ok(actor)
  const [encodedHeader, encodedPayload, signature] = actor.split('.')
  assert.ok(encodedHeader && encodedPayload && signature)
  assert.deepEqual(decodeJwtPart(encodedHeader), {
    alg: 'RS256',
    kid: 'nessie-billing-test',
    typ: 'JWT',
  })
  assert.deepEqual(decodeJwtPart(encodedPayload), {
    iss: 'https://api.nessie.example',
    aud: 'https://uoa.example/billing/v1/effective-tariff',
    sub: 'uoa-user',
    product: 'nessie',
    organisation_id: 'uoa-org',
    team_id: 'uoa-team',
    iat: 1_784_570_000,
    exp: 1_784_570_045,
    jti: 'billing-jti',
  })
  assert.equal(
    verifyBytes(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey(generatedKey.privateKey),
      Buffer.from(signature, 'base64url'),
    ),
    true,
  )
})

test('confirms direct Nessie access only through the exact 204 no-store seam', async () => {
  let requestUrl = ''
  let requestBody: unknown
  const result = confirmUoaDirectServiceAccess({
    organizationId: 'uoa-org',
    teamId: 'uoa-team',
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

test('proxies only the frozen enabled action and preserves its UOA body', async () => {
  const requests: Array<{ body: unknown; path: string }> = []
  const result = await executeUoaBillingHostedAction(
    prisma() as never,
    actorContext as never,
    'upgrade',
    {
      env,
      fetchImpl: (async (input, init) => {
        const path = new URL(input.toString()).pathname
        requests.push({
          body: JSON.parse(String(init?.body)) as unknown,
          path,
        })
        if (path === '/billing/v2/customer-statement') {
          return new Response(JSON.stringify(statement))
        }
        return new Response(JSON.stringify({
          checkout_session_id: 'cs_test_nessie',
          checkout_url: 'https://checkout.stripe.com/c/pay/test',
          expires_at: '2026-07-20T20:00:00.000Z',
          tariff: checkoutTariff,
        }))
      }) as typeof fetch,
    },
  )

  assert.deepEqual(result, {
    redirect_url: 'https://checkout.stripe.com/c/pay/test',
  })
  assert.deepEqual(requests, [
    { body: subjectBody, path: '/billing/v2/customer-statement' },
    {
      body: actionBody,
      path: '/billing/v1/stripe/checkout-session',
    },
  ])
})

test('renders cancellation choices from UOA and sends only opaque confirmation', async () => {
  const cancellable = {
    ...statement,
    subscription: {
      id: 'subscription_nessie',
      status: 'active',
      display_status: 'Active',
      scope: 'team',
      cancel_at_period_end: false,
      current_period_start: '2026-07-01T00:00:00.000Z',
      current_period_end: '2026-08-01T00:00:00.000Z',
    },
    capabilities: {
      can_upgrade: false,
      can_open_portal: true,
      can_cancel: true,
    },
    actions: statement.actions.map((action) =>
      action.id === 'cancel'
        ? { ...action, enabled: true, disabled_reason: null }
        : action),
  }
  const preview = {
    schema_version: 1,
    preview_token: `uoa_cancel_${'t'.repeat(43)}`,
    expires_at: '2026-07-20T12:05:00.000Z',
    title: 'Cancel Nessie?',
    message: 'Choose which direct subscriptions to cancel.',
    choice_required: true,
    choices: [
      {
        id: 'current_service',
        label: 'Cancel Nessie only',
        description: 'Keep DeepWater active.',
        service_ids: ['service_nessie'],
      },
      {
        id: 'current_and_related_direct_services',
        label: 'Cancel all related direct subscriptions',
        description: 'Also cancel DeepWater.',
        service_ids: ['service_nessie', 'service_deepwater'],
      },
    ],
    direct_services: [
      {
        service_id: 'service_nessie',
        product: 'nessie',
        name: 'Nessie',
        display_name: 'Nessie',
        direct_user_count: 2,
        subscription_status: 'active',
      },
      {
        service_id: 'service_deepwater',
        product: 'deepwater',
        name: 'DeepWater',
        display_name: 'DeepWater',
        direct_user_count: 1,
        subscription_status: 'active',
      },
    ],
    indirect_services: [],
    confirm_action: {
      method: 'POST',
      path: '/billing/v1/cancellation/confirm',
      label: 'Confirm cancellation',
      idempotency_key: `uoa_confirm_${'i'.repeat(43)}`,
      selection_required: true,
      default_selection: null,
    },
  }
  const previewResult = await createUoaBillingCancellationPreview(
    prisma() as never,
    actorContext as never,
    {
      env,
      fetchImpl: (async (input) => {
        const path = new URL(input.toString()).pathname
        return new Response(JSON.stringify(
          path === '/billing/v2/customer-statement'
            ? cancellable
            : preview,
        ))
      }) as typeof fetch,
    },
  )
  assert.equal(previewResult.choices[1]?.label, preview.choices[1]?.label)

  let confirmationBody: unknown
  const confirmation = await confirmUoaBillingCancellation(
    prisma() as never,
    actorContext as never,
    {
      preview_token: preview.preview_token,
      idempotency_key: preview.confirm_action.idempotency_key,
      selection: 'current_service',
    },
    {
      env,
      fetchImpl: (async (_input, init) => {
        confirmationBody = JSON.parse(String(init?.body)) as unknown
        return new Response(JSON.stringify({
          schema_version: 1,
          status: 'confirmed',
          title: 'Cancellation scheduled',
          message: 'Nessie will end at its current period boundary.',
          cancelled_services: [
            {
              service_id: 'service_nessie',
              product: 'nessie',
              name: 'Nessie',
              display_name: 'Nessie',
              status: 'cancels_at_period_end',
              effective_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          indirect_services: [],
        }))
      }) as typeof fetch,
    },
  )

  assert.equal(confirmation.title, 'Cancellation scheduled')
  assert.deepEqual(confirmationBody, {
    ...subjectBody,
    preview_token: preview.preview_token,
    idempotency_key: preview.confirm_action.idempotency_key,
    selection: 'current_service',
  })
})

test('rejects path drift, workspace drift, and cross-tenant statements', async () => {
  await assert.rejects(
    executeUoaBillingHostedAction(
      prisma() as never,
      actorContext as never,
      'upgrade',
      {
        env,
        fetchImpl: (async () =>
          new Response(JSON.stringify({
            ...statement,
            actions: statement.actions.map((action) =>
              action.id === 'upgrade'
                ? {
                    ...action,
                    request: {
                      ...action.request,
                      path: '/billing/v1/stripe/portal-session',
                    },
                  }
                : action),
          }))) as typeof fetch,
      },
    ),
    (error: unknown) =>
      error instanceof UoaBillingError
      && error.code === 'UOA_BILLING_ACTION_INVALID',
  )

  await assert.rejects(
    getUoaBillingStatement(
      prisma({ activeOrgId: 'other-org' }) as never,
      actorContext as never,
      undefined,
      { env },
    ),
    (error: unknown) =>
      error instanceof UoaBillingError
      && error.code === 'UOA_BILLING_CONTEXT_MISMATCH',
  )

  await assert.rejects(
    getUoaBillingStatement(
      prisma() as never,
      actorContext as never,
      undefined,
      {
        env,
        fetchImpl: (async () =>
          new Response(JSON.stringify({
            ...statement,
            subject: { ...statement.subject, team_id: 'other-team' },
          }))) as typeof fetch,
      },
    ),
    (error: unknown) =>
      error instanceof UoaBillingError
      && error.code === 'UOA_BILLING_RESPONSE_INVALID',
  )
})

test('rejects portfolio product and exact snapshot drift', async () => {
  const snapshot = statement.pinned_inputs.ledger_snapshots[0]
  const invalidStatements = [
    {
      ...statement,
      connected_service_usage: {
        ...statement.connected_service_usage,
        statement_product: 'deepwater',
      },
    },
    {
      ...statement,
      pinned_inputs: {
        ...statement.pinned_inputs,
        ledger_snapshots: [{
          ...snapshot,
          cursor: `mup_${'2'.repeat(32)}`,
        }],
      },
    },
    {
      ...statement,
      pinned_inputs: {
        ...statement.pinned_inputs,
        ledger_snapshots: [{
          ...snapshot,
          contract: 'metering-usage-v1',
          group_by: 'service',
        }],
      },
    },
  ]

  for (const invalidStatement of invalidStatements) {
    await assert.rejects(
      getUoaBillingStatement(
        prisma() as never,
        actorContext as never,
        undefined,
        {
          env,
          fetchImpl: (async () =>
            new Response(JSON.stringify(invalidStatement))) as typeof fetch,
        },
      ),
      (error: unknown) =>
        error instanceof UoaBillingError
        && error.code === 'UOA_BILLING_RESPONSE_INVALID',
    )
  }
})

test('requires deployment-owned UOA billing credentials', async () => {
  await assert.rejects(
    getUoaBillingStatement(
      prisma() as never,
      actorContext as never,
      undefined,
      { env: { NODE_ENV: 'test' } },
    ),
    (error: unknown) =>
      error instanceof UoaBillingError
      && error.code === 'UOA_BILLING_UNCONFIGURED',
  )
})
