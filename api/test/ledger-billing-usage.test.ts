import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerIdentityService } from '@nessie/runtime'
import {
  getLedgerBillingUsage,
  LedgerBillingUsageError,
  NESSIE_LEDGER_BILLING_READ_KEY_ENV,
} from '../src/services/ledger-billing-usage.js'

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

const responseBody = {
  schemaVersion: 4,
  product: 'nessie',
  scope: {
    organizationId: 'uoa-org',
    teamId: 'uoa-team',
    userId: null,
    month: '2026-07',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-08-01T00:00:00.000Z',
  },
  totals: {
    calls: 1,
    usageByService: [{
      billingProduct: 'deepwater',
      callerProduct: 'nessie',
      originProduct: 'nessie',
      serviceId: 'deepwater',
      usageUnit: 'researches',
      customerBillableUnitLabel: 'billable research-equivalent units',
      ratingStatus: 'rated',
      calls: 1,
      rawProviderUsage: { unitsIn: 1, unitsCachedIn: 0, unitsOut: 0 },
      customerBillableUnits: {
        unitsIn: '1.25',
        unitsCachedIn: '0',
        unitsOut: '0',
      },
    }],
    amounts: [],
    customerCharges: [{
      billingProduct: 'deepwater',
      callerProduct: 'nessie',
      originProduct: 'nessie',
      tariffId: 'tariff-deepwater-team',
      tariffVersion: 3,
      assignmentScope: 'team',
      assignmentId: 'assignment-team',
      collectionMode: 'stripe',
      paymentCollectionEnabled: true,
      stripeCollectible: true,
      currency: 'USD',
      amount: '1.25',
      calls: 1,
    }],
  },
  groupBy: 'user',
  breakdown: [{
    dimension: 'uoa-user',
    billingProduct: 'deepwater',
    callerProduct: 'nessie',
    originProduct: 'nessie',
    tariffId: 'tariff-deepwater-team',
    tariffVersion: 3,
    assignmentScope: 'team',
    assignmentId: 'assignment-team',
    collectionMode: 'stripe',
    paymentCollectionEnabled: true,
    stripeCollectible: true,
    serviceId: 'deepwater',
    usageUnit: 'researches',
    customerBillableUnitLabel: 'billable research-equivalent units',
    ratingStatus: 'rated',
    calls: 1,
    rawProviderUsage: { unitsIn: 1, unitsCachedIn: 0, unitsOut: 0 },
    customerBillableUnits: {
      unitsIn: '1.25',
      unitsCachedIn: '0',
      unitsOut: '0',
    },
    rawProviderCurrency: 'USD',
    rawProviderEstimatedCost: '1',
    rawProviderActualCost: '1',
    billingBaseCurrency: 'USD',
    billingBaseAmount: '1',
    billingMarkupAmount: '0.25',
    customerChargeCurrency: 'USD',
    customerCharge: '1.25',
  }],
  monthlyComponents: [{
    billingProduct: 'deepwater',
    callerProduct: 'nessie',
    originProduct: 'nessie',
    tariffId: 'tariff-deepwater-team',
    tariffKey: 'deepwater-team-125',
    tariffVersion: 3,
    tariffMode: 'markup',
    markupBps: 2500,
    markupPercent: '25',
    usageMultiplierBps: 12500,
    assignmentScope: 'team',
    assignmentId: 'assignment-team',
    amountMinor: '2000',
    currency: 'USD',
    usageBillingEnabled: true,
    collectionMode: 'stripe',
    paymentCollectionEnabled: true,
    stripeCollectible: true,
    observedCalls: 1,
    additiveFutureField: 'preserved',
  }],
  snapshot: {
    cursor: 'bus_test',
    capturedAt: '2026-07-19T00:00:00.000Z',
    immutable: true,
  },
  additiveFutureTopLevel: 'preserved',
}

const prisma = (overrides: {
  externalOrgId?: string | null
  externalWorkspaceId?: string | null
} = {}) => ({
  productAccountLink: {
    findMany: async () => [{
      uoaSub: 'uoa-user',
      user: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
    }],
    findUnique: async () => ({
      activeOrgId: 'uoa-org',
      activeTeamId: 'uoa-team',
      status: 'linked',
      uoaSub: 'uoa-user',
    }),
  },
  team: {
    findFirst: async () => ({
      externalOrgId:
        overrides.externalOrgId === undefined
          ? 'uoa-org'
          : overrides.externalOrgId,
      externalWorkspaceId:
        overrides.externalWorkspaceId === undefined
          ? 'uoa-team'
          : overrides.externalWorkspaceId,
      name: 'Research',
      project: { organization: { name: 'Unlike Other AI' } },
    }),
  },
})

const identityService: LedgerIdentityService = {
  requestHeaders: async (_attribution, options) => {
    assert.equal(options?.delegationScope, 'billing.read')
    assert.equal(options?.requireUoaIdentity, true)
    return {
      'X-Ledger-App-Key': 'delegation-must-not-override-app',
      'X-Nessie-Context': 'nessie-context',
      'X-UOA-Delegation': 'uoa-delegation',
    }
  },
}

test('uses only the dedicated Nessie reader key and preserves raw/rated usage', async () => {
  let requestedUrl = ''
  let requestedHeaders = new Headers()
  const result = await getLedgerBillingUsage(
    prisma() as never,
    actorContext as never,
    { groupBy: 'user', month: '2026-07' },
    {
      env: {
        LEDGER_PUBLIC_URL: 'https://ledger.example',
        [NESSIE_LEDGER_BILLING_READ_KEY_ENV]: 'nessie-reader-key',
        LEDGER_PROXY_TOKEN: 'nessie-inference-key',
      },
      identityService,
      fetchImpl: (async (input, init) => {
        requestedUrl = input.toString()
        requestedHeaders = new Headers(init?.headers)
        return new Response(JSON.stringify(responseBody))
      }) as typeof fetch,
    },
  )

  const url = new URL(requestedUrl)
  assert.equal(url.pathname, '/v1/billing/usage')
  assert.equal(url.searchParams.get('organization_id'), 'uoa-org')
  assert.equal(url.searchParams.get('team_id'), 'uoa-team')
  assert.equal(url.searchParams.get('group_by'), 'user')
  assert.equal(
    requestedHeaders.get('x-ledger-app-key'),
    'nessie-reader-key',
  )
  assert.equal(requestedHeaders.get('authorization'), null)
  assert.equal(result.breakdown[0]?.rawProviderUsage.unitsIn, 1)
  assert.equal(result.breakdown[0]?.customerBillableUnits.unitsIn, '1.25')
  assert.equal(result.breakdown[0]?.originProduct, 'nessie')
  assert.equal(result.breakdown[0]?.stripeCollectible, true)
  assert.equal(result.totals.customerCharges[0]?.collectionMode, 'stripe')
  assert.equal(result.monthlyComponents[0]?.additiveFutureField, 'preserved')
  assert.equal(result.additiveFutureTopLevel, 'preserved')
  assert.equal(result.display.dimensionLabels['uoa-user'], 'Ada Lovelace')
})

test('rejects inference-key reuse before making a billing request', async () => {
  await assert.rejects(
    getLedgerBillingUsage(
      prisma() as never,
      actorContext as never,
      { groupBy: 'service', month: '2026-07' },
      {
        env: {
          LEDGER_PUBLIC_URL: 'https://ledger.example',
          [NESSIE_LEDGER_BILLING_READ_KEY_ENV]: 'shared-key',
          LEDGER_PROXY_TOKEN: 'shared-key',
        },
        identityService,
      },
    ),
    (error: unknown) =>
      error instanceof LedgerBillingUsageError
      && error.code === 'LEDGER_BILLING_UNCONFIGURED',
  )
})

test('fails closed when the signed UOA workspace differs from the Nessie team', async () => {
  await assert.rejects(
    getLedgerBillingUsage(
      prisma({ externalWorkspaceId: 'another-team' }) as never,
      actorContext as never,
      { groupBy: 'service', month: '2026-07' },
      {
        env: {
          LEDGER_PUBLIC_URL: 'https://ledger.example',
          [NESSIE_LEDGER_BILLING_READ_KEY_ENV]: 'nessie-reader-key',
        },
        identityService,
      },
    ),
    (error: unknown) =>
      error instanceof LedgerBillingUsageError
      && error.code === 'LEDGER_BILLING_CONTEXT_MISMATCH',
  )
})
