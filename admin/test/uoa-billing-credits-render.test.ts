import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ApiClientProvider,
  type ApiClient,
} from '@nessie/client-core'
import {
  billingCreditsV1ConformanceFixture,
  type BillingCreditsManagerV1,
  type BillingCreditsMemberV1,
} from '@unlikeotherai/billing-statement-protocol'
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { UoaBillingCreditsPanel } from '../src/components/features/billing/UoaBillingCreditsPanel.js'
import { billingCreditsKey } from '../src/facades/billing/hooks.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const manager = billingCreditsV1ConformanceFixture as BillingCreditsManagerV1

const zeroCredits = {
  credits: '0',
  display: '0 credits',
  usd_equivalent: {
    amount: '0',
    currency: 'USD' as const,
    display: 'US$0.00',
  },
}

const member = {
  ...manager,
  viewer: {
    role: 'member',
    usage_visibility: 'own_plus_team_aggregate',
    description: 'Your usage and anonymous team totals.',
  },
  capabilities: {
    can_top_up: false,
    can_manage_automatic_top_up: false,
  },
  credit_summary: {
    ...manager.credit_summary,
    consumed_breakdown: manager.credit_summary.consumed_breakdown.map(
      (service) => ({
        service: service.service,
        credits_consumed: service.credits_consumed,
        viewer_credits_consumed:
          service.users.find(
            (user) => user.user_id === manager.subject.user_id,
          )?.credits_consumed ?? zeroCredits,
        other_team_members_credits_consumed:
          service.users.find(
            (user) => user.user_id !== manager.subject.user_id,
          )?.credits_consumed ?? zeroCredits,
        unattributed_credits_consumed:
          service.unattributed_credits_consumed,
      }),
    ),
  },
  funding_policy: {
    ...manager.funding_policy,
    offers: manager.funding_policy.offers.map((offer) => ({
      ...offer,
      action: null,
    })),
  },
  automatic_top_up: {
    ...manager.automatic_top_up,
    payment_method: {
      status: manager.automatic_top_up.payment_method.status,
    },
    consent: {
      status: manager.automatic_top_up.consent.status,
      version: manager.automatic_top_up.consent.version,
      consented_at: manager.automatic_top_up.consent.consented_at,
    },
    options: manager.automatic_top_up.options.map((option) => ({
      ...option,
      setup_action: null,
      update_action: null,
    })),
    disable_action: null,
    recover_action: null,
  },
  recent_entries: manager.recent_entries.map(({ attribution, ...entry }) => ({
    ...entry,
    attribution: attribution.kind === 'user'
      ? attribution.user_id === manager.subject.user_id
        ? 'viewer'
        : 'other_team_members'
      : attribution.kind,
  })),
} as unknown as BillingCreditsMemberV1

const unusedApiClient: ApiClient = {
  delete: async () => {
    throw new Error('unexpected request')
  },
  get: async () => {
    throw new Error('unexpected request')
  },
  patch: async () => {
    throw new Error('unexpected request')
  },
  post: async () => {
    throw new Error('unexpected request')
  },
  put: async () => {
    throw new Error('unexpected request')
  },
}

const renderCredits = (
  credits: BillingCreditsManagerV1 | BillingCreditsMemberV1,
): string => {
  const queryClient = new QueryClient()
  queryClient.setQueryData(billingCreditsKey, credits)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: unusedApiClient },
        createElement(UoaBillingCreditsPanel),
      ),
    ),
  )
}

test('manager view leads with remaining credits and exposes UOA actions', () => {
  const markup = renderCredits(manager)

  assert.match(markup, /Remaining credits/)
  assert.match(markup, /pending/i)
  assert.match(markup, /Credits used by service/)
  assert.match(markup, /Automatic top-up options/)
  assert.match(markup, /Full team detail/)
  assert.ok(markup.includes(
    manager.funding_policy.offers[0]?.action.label ?? '',
  ))
})

test('member view preserves team transparency without names or money actions', () => {
  const markup = renderCredits(member)
  const otherUser = manager.credit_summary.consumed_breakdown
    .flatMap((service) => service.users)
    .find((user) => user.user_id !== manager.subject.user_id)

  assert.match(markup, /Remaining credits/)
  assert.match(markup, /Your usage \+ team totals/)
  assert.match(markup, /other members/)
  assert.doesNotMatch(markup, /Automatic top-up options/)
  if (otherUser) assert.doesNotMatch(markup, new RegExp(otherUser.display_name))
})
