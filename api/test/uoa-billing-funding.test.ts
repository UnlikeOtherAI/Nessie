import assert from 'node:assert/strict'
import test from 'node:test'

import {
  billingCreditsV1ConformanceFixture,
  billingRecurringAddonV1ConformanceFixtures,
} from '@unlikeotherai/billing-statement-protocol'

import {
  confirmUoaBillingRecurringAddonCancellation,
  createUoaBillingCreditTopUp,
  createUoaBillingRecurringAddonCancellationPreview,
  getUoaBillingCredits,
  getUoaBillingRecurringAddons,
  updateUoaBillingAutoTopUp,
} from '../src/services/uoa-billing-funding.js'
import {
  UoaBillingError,
} from '../src/services/uoa-billing-client.js'
import {
  actorContext,
  env,
  prisma,
  subjectBody,
} from './uoa-billing-statement-fixtures.js'

const exactSubject = {
  user_id: 'uoa-user',
  organisation_id: 'uoa-org',
  team_id: 'uoa-team',
}

const bindFixture = <T>(value: T): T => JSON.parse(
  JSON.stringify(value)
    .replaceAll('deepwater', 'nessie')
    .replaceAll('org_example', 'uoa-org')
    .replaceAll('team_example', 'uoa-team')
    .replaceAll('user_example', 'uoa-user'),
) as T

const credits = bindFixture({
  ...billingCreditsV1ConformanceFixture,
  subject: exactSubject,
})

const recurringAddons = bindFixture({
  ...billingRecurringAddonV1ConformanceFixtures.recurring_addons,
  subject: exactSubject,
})

test('loads exact shared credits and recurring add-ons for the active team', async () => {
  const requests: Array<{ body: unknown; path: string }> = []
  const fetchImpl = (async (input, init) => {
    const path = new URL(input.toString()).pathname
    requests.push({
      body: JSON.parse(String(init?.body)) as unknown,
      path,
    })
    return new Response(JSON.stringify(
      path === '/billing/v1/credits' ? credits : recurringAddons,
    ))
  }) as typeof fetch

  const [creditResult, addonResult] = await Promise.all([
    getUoaBillingCredits(prisma() as never, actorContext as never, {
      env,
      fetchImpl,
    }),
    getUoaBillingRecurringAddons(prisma() as never, actorContext as never, {
      env,
      fetchImpl,
    }),
  ])

  assert.equal(creditResult.credit_balance.label, 'Remaining credits')
  assert.equal(addonResult.product.identifier, 'nessie')
  assert.deepEqual(
    requests.sort((left, right) => left.path.localeCompare(right.path)),
    [
      { body: subjectBody, path: '/billing/v1/credits' },
      { body: subjectBody, path: '/billing/v1/recurring-addons' },
    ],
  )
})

test('rejects cross-product and cross-team funding projections', async () => {
  for (const response of [
    {
      ...credits,
      storefront: { ...credits.storefront, identifier: 'deepwater' },
    },
    {
      ...credits,
      subject: { ...credits.subject, team_id: 'other-team' },
    },
  ]) {
    await assert.rejects(
      getUoaBillingCredits(
        prisma() as never,
        actorContext as never,
        {
          env,
          fetchImpl: (async () =>
            new Response(JSON.stringify(response))) as typeof fetch,
        },
      ),
      (error: unknown) =>
        error instanceof UoaBillingError
        && error.code === 'UOA_BILLING_RESPONSE_INVALID',
    )
  }
})

test('re-fetches and relays the exact frozen credit top-up action', async () => {
  const requests: Array<{ body: unknown; path: string }> = []
  const offer = credits.funding_policy.offers[0]
  assert.ok(offer)

  const result = await createUoaBillingCreditTopUp(
    prisma() as never,
    actorContext as never,
    offer.id,
    {
      env,
      fetchImpl: (async (input, init) => {
        const path = new URL(input.toString()).pathname
        requests.push({
          body: JSON.parse(String(init?.body)) as unknown,
          path,
        })
        return new Response(JSON.stringify(
          path === '/billing/v1/credits'
            ? credits
            : { redirect_url: 'https://checkout.stripe.com/c/pay/credits' },
        ))
      }) as typeof fetch,
    },
  )

  assert.equal(
    result.redirect_url,
    'https://checkout.stripe.com/c/pay/credits',
  )
  assert.deepEqual(requests, [
    { body: subjectBody, path: '/billing/v1/credits' },
    {
      body: offer.action.request.body,
      path: '/billing/v1/credits/top-up-checkout',
    },
  ])
})

test('selects only an exact UOA-authored auto-top-up option', async () => {
  const option = credits.automatic_top_up.options[0]
  assert.ok(option)
  const optionId = option.update_action.request.body.option_id
  const requests: Array<{ body: unknown; path: string }> = []

  await updateUoaBillingAutoTopUp(
    prisma() as never,
    actorContext as never,
    optionId,
    {
      env,
      fetchImpl: (async (input, init) => {
        const path = new URL(input.toString()).pathname
        requests.push({
          body: JSON.parse(String(init?.body)) as unknown,
          path,
        })
        if (path === '/billing/v1/credits') {
          return new Response(JSON.stringify(credits))
        }
        return new Response(null, {
          headers: { 'Cache-Control': 'private, no-store' },
          status: 204,
        })
      }) as typeof fetch,
    },
  )

  assert.deepEqual(requests, [
    { body: subjectBody, path: '/billing/v1/credits' },
    {
      body: option.update_action.request.body,
      path: '/billing/v1/credits/auto-top-up/update',
    },
  ])

  await assert.rejects(
    updateUoaBillingAutoTopUp(
      prisma() as never,
      actorContext as never,
      'forged-option',
      {
        env,
        fetchImpl: (async () =>
          new Response(JSON.stringify(credits))) as typeof fetch,
      },
    ),
    (error: unknown) =>
      error instanceof UoaBillingError
      && error.code === 'UOA_BILLING_ACTION_INVALID',
  )
})

test('relays only the frozen add-on cancellation and opaque confirmation', async () => {
  const offer = recurringAddons.offers[0]
  const cancelAction = offer?.actions.find((action) => action.id === 'cancel')
  assert.ok(cancelAction?.id === 'cancel')
  const subscriptionId = cancelAction.request.body.subscription_id
  const preview = bindFixture(
    billingRecurringAddonV1ConformanceFixtures.cancellation_preview,
  )
  const requests: Array<{ body: unknown; path: string }> = []

  const previewResult =
    await createUoaBillingRecurringAddonCancellationPreview(
      prisma() as never,
      actorContext as never,
      subscriptionId,
      {
        env,
        fetchImpl: (async (input, init) => {
          const path = new URL(input.toString()).pathname
          requests.push({
            body: JSON.parse(String(init?.body)) as unknown,
            path,
          })
          return new Response(JSON.stringify(
            path === '/billing/v1/recurring-addons'
              ? recurringAddons
              : preview,
          ))
        }) as typeof fetch,
      },
    )

  assert.equal(previewResult.subscription.id, subscriptionId)
  assert.deepEqual(requests, [
    { body: subjectBody, path: '/billing/v1/recurring-addons' },
    {
      body: cancelAction.request.body,
      path: '/billing/v1/recurring-addons/cancellation/preview',
    },
  ])

  let confirmationBody: unknown
  const confirmation = await confirmUoaBillingRecurringAddonCancellation(
    prisma() as never,
    actorContext as never,
    {
      choice: 'cancel_addon',
      idempotency_key: preview.idempotency_key,
      preview_token: preview.preview_token,
    },
    {
      env,
      fetchImpl: (async (_input, init) => {
        confirmationBody = JSON.parse(String(init?.body)) as unknown
        return new Response(JSON.stringify(bindFixture(
          billingRecurringAddonV1ConformanceFixtures.cancellation_confirmation,
        )))
      }) as typeof fetch,
    },
  )
  assert.equal(confirmation.status, 'scheduled')
  assert.deepEqual(confirmationBody, preview.confirm_action.body)
})
