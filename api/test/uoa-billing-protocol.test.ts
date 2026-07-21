import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  billingConsumerActionV1ConformanceFixtures,
  billingStatementV2ConformanceFixture,
} from '@unlikeotherai/billing-statement-protocol'

import {
  parseBillingCancellationConfirmationV1,
  parseBillingCancellationConfirmRequest,
  parseBillingCancellationPreviewV1,
  parseBillingHostedRedirectResponse,
  parseBillingStatementV2,
} from '../src/services/uoa-billing-protocol.js'

describe('public UOA billing protocol consumer', () => {
  it('accepts the public package fixtures at every Nessie API boundary', () => {
    assert.deepEqual(
      parseBillingStatementV2(billingStatementV2ConformanceFixture),
      billingStatementV2ConformanceFixture,
    )
    assert.deepEqual(
      parseBillingHostedRedirectResponse(
        billingConsumerActionV1ConformanceFixtures.hosted_redirect_response,
      ),
      billingConsumerActionV1ConformanceFixtures.hosted_redirect_response,
    )
    assert.deepEqual(
      parseBillingCancellationPreviewV1(
        billingConsumerActionV1ConformanceFixtures.cancellation_preview,
      ),
      billingConsumerActionV1ConformanceFixtures.cancellation_preview,
    )
    assert.deepEqual(
      parseBillingCancellationConfirmRequest(
        billingConsumerActionV1ConformanceFixtures.cancellation_confirm_request,
      ),
      billingConsumerActionV1ConformanceFixtures.cancellation_confirm_request,
    )
    assert.deepEqual(
      parseBillingCancellationConfirmationV1(
        billingConsumerActionV1ConformanceFixtures.cancellation_confirmation,
      ),
      billingConsumerActionV1ConformanceFixtures.cancellation_confirmation,
    )
  })

  it('rejects product-added fields instead of widening the public contract', () => {
    assert.equal(
      parseBillingStatementV2({
        ...billingStatementV2ConformanceFixture,
        locally_rated_total: '$99.00',
      }),
      null,
    )
    assert.equal(
      parseBillingCancellationPreviewV1({
        ...billingConsumerActionV1ConformanceFixtures.cancellation_preview,
        product_decision: 'cancel_everything',
      }),
      null,
    )
  })
})
