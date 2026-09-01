import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  billingConsumerActionV1ConformanceFixtures,
  billingCreditsV1ConformanceFixture,
  billingStatementV2ConformanceFixture,
  type BillingCreditsManagerV1,
  type BillingCreditsMemberV1,
} from '@unlikeotherai/billing-statement-protocol'

import {
  parseBillingCancellationConfirmationV1,
  parseBillingCancellationConfirmRequest,
  parseBillingCancellationPreviewV1,
  parseBillingCreditsV1,
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

  it('accepts empty credit activity while rejecting cross-role entries', () => {
    const manager = billingCreditsV1ConformanceFixture as BillingCreditsManagerV1
    const emptyManager = {
      ...manager,
      credit_summary: { ...manager.credit_summary, consumed_breakdown: [] },
      recent_entries: [],
    }
    const emptyMember = {
      ...manager,
      viewer: {
        role: 'member',
        usage_visibility: 'own_plus_team_aggregate',
        description: 'This viewer sees their usage plus anonymous team aggregates.',
      },
      capabilities: { can_top_up: false, can_manage_automatic_top_up: false },
      pending_credits: { ...manager.pending_credits, payment_amount: null },
      credit_summary: { ...manager.credit_summary, consumed_breakdown: [] },
      funding_policy: null,
      automatic_top_up: {
        payment_method: { status: manager.automatic_top_up.payment_method.status },
      },
      recent_entries: [],
    } as unknown as BillingCreditsMemberV1

    assert.equal(parseBillingCreditsV1(emptyManager), emptyManager)
    assert.equal(parseBillingCreditsV1(emptyMember), emptyMember)

    const managerBreakdown = manager.credit_summary.consumed_breakdown[0]
    const managerEntry = manager.recent_entries[0]
    assert.ok(managerBreakdown)
    assert.ok(managerEntry)
    const memberBreakdown = {
      service: managerBreakdown.service,
      credits_consumed: managerBreakdown.credits_consumed,
      viewer_credits_consumed: managerBreakdown.credits_consumed,
      other_team_members_credits_consumed:
        managerBreakdown.unattributed_credits_consumed,
      unattributed_credits_consumed:
        managerBreakdown.unattributed_credits_consumed,
    }
    const memberEntry = {
      ...managerEntry,
      attribution: 'other_team_members' as const,
    }

    assert.equal(parseBillingCreditsV1({
      ...manager,
      credit_summary: {
        ...manager.credit_summary,
        consumed_breakdown: [memberBreakdown],
      },
    }), null)
    assert.equal(parseBillingCreditsV1({
      ...emptyMember,
      credit_summary: {
        ...emptyMember.credit_summary,
        consumed_breakdown: [managerBreakdown],
      },
    }), null)
    assert.equal(parseBillingCreditsV1({
      ...manager,
      recent_entries: [memberEntry],
    }), null)
    assert.equal(parseBillingCreditsV1({
      ...manager,
      recent_entries: [managerEntry, memberEntry],
    }), null)
    assert.equal(parseBillingCreditsV1({
      ...emptyMember,
      recent_entries: [managerEntry],
    }), null)
  })
})
