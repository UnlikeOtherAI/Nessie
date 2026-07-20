import assert from 'node:assert/strict'
import {
  createPublicKey,
  generateKeyPairSync,
  verify as verifyBytes,
} from 'node:crypto'
import test from 'node:test'

import {
  createUoaBillingCheckout,
  getUoaBillingSubscription,
  NESSIE_UOA_BILLING_ACTOR_KEY_ENV,
  NESSIE_UOA_BILLING_APP_KEY_ENV,
  UoaBillingSubscriptionError,
} from '../src/services/uoa-billing-subscription.js'

const actorContext = {
  actionContext: {
    correlationId: 'correlation-1',
    requestId: 'request-1',
  },
  actor: {
    actorId: '00000000-0000-4000-8000-000000000001',
    actorType: 'user',
    roles: ['owner'],
  },
  tenant: {
    organizationId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    teamId: '00000000-0000-4000-8000-000000000004',
  },
}

const generatedKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateJwk = {
  ...generatedKey.privateKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'nessie-billing-test',
  use: 'sig',
}

const env = {
  NODE_ENV: 'test',
  UOA_BASE_URL: 'https://uoa.example',
  NESSIE_API_PUBLIC_URL: 'https://api.nessie.example',
  NESSIE_ADMIN_PUBLIC_URL: 'https://app.nessie.example',
  [NESSIE_UOA_BILLING_APP_KEY_ENV]: `uoa_app_${'n'.repeat(32)}`,
  [NESSIE_UOA_BILLING_ACTOR_KEY_ENV]: JSON.stringify(privateJwk),
}

const prisma = (overrides: {
  activeOrgId?: string
  externalOrgId?: string
} = {}) => ({
  productAccountLink: {
    findUnique: async () => ({
      activeOrgId: overrides.activeOrgId ?? 'uoa-org',
      activeTeamId: 'uoa-team',
      status: 'linked',
      uoaSub: 'uoa-user',
    }),
  },
  team: {
    findFirst: async () => ({
      externalOrgId: overrides.externalOrgId ?? 'uoa-org',
      externalWorkspaceId: 'uoa-team',
      name: 'Research',
      project: { organization: { name: 'Unlike Other AI' } },
    }),
  },
})

const tariff = {
  id: 'tariff_nessie',
  key: 'standard',
  version: 3,
  mode: 'standard',
  collection_mode: 'stripe',
  markup_bps: 2_000,
  markup_percent: '20.00',
  usage_price_multiplier_bps: 12_000,
  monthly_subscription: {
    amount_minor: '2000',
    currency: 'USD',
  },
  usage_billing_enabled: true,
  payment_collection_enabled: true,
  raw_usage_preserved: true,
}

const summary = {
  product: { id: 'service_nessie', identifier: 'nessie' },
  subject: {
    user_id: 'uoa-user',
    organisation_id: 'uoa-org',
    team_id: 'uoa-team',
  },
  tariff,
  assignment: { scope: 'team', id: 'assignment_nessie' },
  stripe_collection_enabled: true,
  stripe_mode: 'test',
  can_manage: true,
  subscription: null,
}

const decodeJwtPart = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >

test('binds the dedicated Nessie app key to a signed exact SSO actor', async () => {
  let requestUrl = ''
  let requestHeaders = new Headers()
  let requestBody: Record<string, unknown> = {}
  const result = await getUoaBillingSubscription(
    prisma() as never,
    actorContext as never,
    {
      env,
      now: () => 1_784_570_000,
      randomId: () => 'billing-jti',
      fetchImpl: (async (input, init) => {
        requestUrl = input.toString()
        requestHeaders = new Headers(init?.headers)
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify(summary))
      }) as typeof fetch,
    },
  )

  assert.deepEqual(result, summary)
  assert.equal(
    requestUrl,
    'https://uoa.example/billing/v1/stripe/subscription-summary',
  )
  assert.equal(
    requestHeaders.get('x-uoa-app-key'),
    env[NESSIE_UOA_BILLING_APP_KEY_ENV],
  )
  assert.deepEqual(requestBody, {
    product: 'nessie',
    organisation_id: 'uoa-org',
    team_id: 'uoa-team',
    user_id: 'uoa-user',
  })

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

test('pins Checkout return URLs to the Nessie deployment', async () => {
  let requestBody: Record<string, unknown> = {}
  const result = await createUoaBillingCheckout(
    prisma() as never,
    actorContext as never,
    {
      env,
      fetchImpl: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({
          checkout_session_id: 'cs_test_nessie',
          checkout_url: 'https://checkout.stripe.com/c/pay/test',
          expires_at: '2026-07-20T20:00:00.000Z',
          tariff,
        }))
      }) as typeof fetch,
    },
  )

  assert.equal(result.checkout_session_id, 'cs_test_nessie')
  assert.equal(
    requestBody.success_url,
    'https://app.nessie.example/tokens?billing=success',
  )
  assert.equal(
    requestBody.cancel_url,
    'https://app.nessie.example/tokens?billing=cancelled',
  )
})

test('fails closed on workspace drift and cross-tenant UOA responses', async () => {
  await assert.rejects(
    getUoaBillingSubscription(
      prisma({ activeOrgId: 'other-org' }) as never,
      actorContext as never,
      { env },
    ),
    (error: unknown) =>
      error instanceof UoaBillingSubscriptionError
      && error.code === 'UOA_BILLING_CONTEXT_MISMATCH',
  )

  await assert.rejects(
    getUoaBillingSubscription(
      prisma() as never,
      actorContext as never,
      {
        env,
        fetchImpl: (async () =>
          new Response(JSON.stringify({
            ...summary,
            subject: {
              ...summary.subject,
              team_id: 'other-team',
            },
          }))) as typeof fetch,
      },
    ),
    (error: unknown) =>
      error instanceof UoaBillingSubscriptionError
      && error.code === 'UOA_BILLING_RESPONSE_INVALID',
  )
})

test('requires deployment-owned UOA billing credentials', async () => {
  await assert.rejects(
    getUoaBillingSubscription(
      prisma() as never,
      actorContext as never,
      { env: { NODE_ENV: 'test' } },
    ),
    (error: unknown) =>
      error instanceof UoaBillingSubscriptionError
      && error.code === 'UOA_BILLING_UNCONFIGURED',
  )
})
