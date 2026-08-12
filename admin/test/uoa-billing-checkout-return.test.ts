import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getUoaBillingCheckoutReturnNotice,
  readUoaBillingCheckoutReturn,
  resolveRootLandingPath,
} from '../src/facades/billing/checkout-return.js'

test('root checkout returns preserve the complete query when routing to credits', () => {
  const complete = '?source=a%2Fb&uoa_billing=checkout_complete&campaign=summer+sale'
  const cancelled = '?uoa_billing=checkout_cancelled&source=pricing'

  assert.equal(resolveRootLandingPath(complete), `/tokens${complete}`)
  assert.equal(resolveRootLandingPath(cancelled), `/tokens${cancelled}`)
})

test('a native notification target wins over the default root landing route', () => {
  const notificationPath =
    '/channels/7786605b-1316-4a7a-8e8b-58b4a05e19b6/threads/31e71af1-29de-4cfe-8459-430d78dff174/replies/0bb5ff10-07be-4d11-82cb-7048a8cb7fc6'

  assert.equal(resolveRootLandingPath('', notificationPath), notificationPath)
  assert.equal(
    resolveRootLandingPath('?uoa_billing=checkout_complete', notificationPath),
    notificationPath,
  )
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
      'You are back from checkout. We are refreshing your team credits and billing details so they can show confirmed changes.',
  })
  assert.deepEqual(getUoaBillingCheckoutReturnNotice(cancelled), {
    title: 'Billing checkout',
    message:
      'You are back from checkout. We are refreshing your team credits and billing details; no billing change is assumed.',
  })
})
