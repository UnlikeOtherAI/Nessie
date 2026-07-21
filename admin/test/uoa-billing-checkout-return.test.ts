import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getUoaBillingCheckoutReturnNotice,
  readUoaBillingCheckoutReturn,
  resolveRootLandingPath,
} from '../src/facades/billing/checkout-return.js'

test('root checkout returns preserve the complete query when routing to usage', () => {
  const complete = '?source=a%2Fb&uoa_billing=checkout_complete&campaign=summer+sale'
  const cancelled = '?uoa_billing=checkout_cancelled&source=pricing'

  assert.equal(resolveRootLandingPath(complete), `/tokens${complete}`)
  assert.equal(resolveRootLandingPath(cancelled), `/tokens${cancelled}`)
})

test('only one exact checkout-return value activates billing behavior', () => {
  const invalidSearches = [
    '',
    '?uoa_billing=',
    '?uoa_billing=complete',
    '?uoa_billing=CHECKOUT_COMPLETE',
    '?uoa_billing=checkout_complete&uoa_billing=checkout_cancelled',
  ]

  for (const search of invalidSearches) {
    assert.equal(readUoaBillingCheckoutReturn(search), null)
    assert.equal(resolveRootLandingPath(search), '/channels')
  }
})

test('valid returns map to neutral statement-refresh notices', () => {
  const complete = readUoaBillingCheckoutReturn(
    '?uoa_billing=checkout_complete',
  )
  const cancelled = readUoaBillingCheckoutReturn(
    '?uoa_billing=checkout_cancelled',
  )

  assert.equal(complete, 'checkout_complete')
  assert.equal(cancelled, 'checkout_cancelled')
  assert.deepEqual(getUoaBillingCheckoutReturnNotice(complete), {
    title: 'Billing checkout',
    message:
      'You are back from checkout. We are refreshing the customer statement below so it can show any confirmed changes.',
  })
  assert.deepEqual(getUoaBillingCheckoutReturnNotice(cancelled), {
    title: 'Billing checkout',
    message:
      'You are back from checkout. We are refreshing the customer statement below; no billing change is assumed.',
  })
})
