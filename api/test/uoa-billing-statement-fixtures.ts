import { generateKeyPairSync } from 'node:crypto'

import {
  NESSIE_UOA_BILLING_ACTOR_KEY_ENV,
  NESSIE_UOA_BILLING_APP_KEY_ENV,
} from '../src/services/uoa-billing-client.js'

export const actorContext = {
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

export const generatedKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const privateJwk = {
  ...generatedKey.privateKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: 'nessie-billing-test',
  use: 'sig',
}

export const env = {
  NODE_ENV: 'test',
  UOA_BASE_URL: 'https://uoa.example',
  NESSIE_API_PUBLIC_URL: 'https://api.nessie.example',
  [NESSIE_UOA_BILLING_APP_KEY_ENV]: `uoa_app_${'n'.repeat(32)}`,
  [NESSIE_UOA_BILLING_ACTOR_KEY_ENV]: JSON.stringify(privateJwk),
}

export const prisma = (overrides: {
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

export const subjectBody = {
  product: 'nessie',
  organisation_id: 'uoa-org',
  team_id: 'uoa-team',
  user_id: 'uoa-user',
}
const money = (amount: string, display: string) => ({
  amount,
  currency: 'USD',
  display,
})
export const actionBody = {
  ...subjectBody,
  success_url: 'https://app.nessie.works/?uoa_billing=checkout_complete',
  cancel_url: 'https://app.nessie.works/?uoa_billing=checkout_cancelled',
}

export const statement = {
  schema_version: 1,
  statement_id: 'bst_nessie_july',
  generated_at: '2026-07-20T12:00:00.000Z',
  product: {
    id: 'service_nessie',
    identifier: 'nessie',
    name: 'Nessie',
  },
  subject: {
    user_id: 'uoa-user',
    organisation_id: 'uoa-org',
    team_id: 'uoa-team',
  },
  period: {
    key: '2026-07',
    starts_at: '2026-07-01T00:00:00.000Z',
    ends_at: '2026-08-01T00:00:00.000Z',
    state: 'open',
  },
  pinned_inputs: {
    ledger_snapshots: [
      {
        group_by: 'service',
        cursor: 'meter_service',
        id: 'snapshot_service',
        captured_at: '2026-07-20T12:00:00.000Z',
        sha256: 'a'.repeat(64),
      },
      {
        group_by: 'user',
        cursor: 'meter_user',
        id: 'snapshot_user',
        captured_at: '2026-07-20T12:00:00.000Z',
        sha256: 'b'.repeat(64),
      },
    ],
    tariff: { id: 'tariff_nessie', version: 3 },
  },
  plan: {
    tariff_id: 'tariff_nessie',
    key: 'standard',
    version: 3,
    name: 'Standard',
    display_name: 'Standard · 20% service value',
    mode: 'standard',
    collection_mode: 'stripe',
    markup_bps: 2_000,
    markup_percent: '20.00',
    markup_display: '20% service value',
    usage_multiplier_bps: 12_000,
    monthly_subscription: {
      ...money('20.00', '$20.00'),
      amount_minor: '2000',
    },
    assignment: { scope: 'team', id: 'assignment_nessie' },
  },
  collection: {
    payment_collection_enabled: true,
    stripe_collection_enabled: true,
    stripe_mode: 'test',
  },
  subscription: null,
  services: [
    {
      product: 'nessie',
      name: 'Nessie',
      display_name: 'Nessie',
      access: 'direct',
      direct_user_count: 2,
      roles: ['billing_product', 'caller_product', 'origin_product'],
    },
    {
      product: 'deepwater',
      name: 'DeepWater',
      display_name: 'DeepWater',
      access: 'indirect',
      direct_user_count: 0,
      roles: ['billing_product'],
    },
  ],
  usage: {
    lines: [
      {
        id: 'usage_deepwater',
        service_id: 'deepwater',
        usage_unit: 'tokens',
        calls: '2',
        attribution: {
          user_id: 'uoa-user',
          billing_product: 'deepwater',
          caller_product: 'nessie',
          origin_product: 'nessie',
        },
        raw_units: {
          input: '80',
          cached_input: '0',
          output: '20',
          total: '100',
        },
        billable_units: {
          input: '96',
          cached_input: '0',
          output: '24',
          total: '120',
        },
        share: {
          basis_points: 4_400,
          percent: '44.00',
          display: '44% of team DeepWater usage came through Nessie',
        },
        provider_cost: {
          ...money('1.00', '$1.00'),
          provenance: 'ledger',
        },
        rated_charge: {
          base: money('1.00', '$1.00'),
          markup: money('0.20', '$0.20'),
          total: money('1.20', '$1.20'),
        },
      },
    ],
    totals: [
      {
        usage_unit: 'tokens',
        raw_units: '100',
        billable_units: '120',
        display: '100 raw tokens · 120 billed tokens',
      },
    ],
    cost_totals: [
      {
        currency: 'USD',
        provider_cost: money('1.00', '$1.00'),
        markup: money('0.20', '$0.20'),
        usage_charge: money('1.20', '$1.20'),
      },
    ],
    user_totals: [
      {
        user_id: 'uoa-user',
        name: 'Ada',
        email: 'ada@example.com',
        calls: '2',
        usage: [
          {
            usage_unit: 'tokens',
            raw_units: '100',
            billable_units: '120',
          },
        ],
        costs: [
          {
            currency: 'USD',
            provider_cost: money('1.00', '$1.00'),
            markup: money('0.20', '$0.20'),
            usage_charge: money('1.20', '$1.20'),
          },
        ],
      },
    ],
  },
  commercial_lines: [
    {
      id: 'monthly_nessie',
      kind: 'monthly_subscription',
      product: 'nessie',
      label: 'Nessie Standard',
      detail: 'Monthly subscription',
      amount: money('20.00', '$20.00'),
    },
  ],
  totals: [
    {
      currency: 'USD',
      monthly: money('20.00', '$20.00'),
      usage: money('1.20', '$1.20'),
      add_ons: money('0.00', '$0.00'),
      credits: money('0.00', '$0.00'),
      total_due: money('21.20', '$21.20'),
    },
  ],
  capabilities: {
    can_upgrade: true,
    can_open_portal: false,
    can_cancel: false,
  },
  actions: [
    {
      id: 'upgrade',
      kind: 'hosted_redirect',
      label: 'Upgrade plan',
      description: 'Choose and pay through Stripe Checkout.',
      enabled: true,
      disabled_reason: null,
      request: {
        method: 'POST',
        path: '/billing/v1/stripe/checkout-session',
        body: actionBody,
      },
    },
    {
      id: 'portal',
      kind: 'hosted_redirect',
      label: 'Manage payment',
      description: 'Open Stripe’s hosted billing portal.',
      enabled: false,
      disabled_reason: 'No subscription is active.',
      request: {
        method: 'POST',
        path: '/billing/v1/stripe/portal-session',
        body: {
          ...subjectBody,
          return_url: 'https://app.nessie.works/',
        },
      },
    },
    {
      id: 'cancel',
      kind: 'confirmation_dialog',
      label: 'Cancel subscription',
      description: 'Preview the exact products affected.',
      enabled: false,
      disabled_reason: 'No cancellable subscription is active.',
      request: {
        method: 'POST',
        path: '/billing/v1/cancellation/preview',
        body: subjectBody,
      },
    },
  ],
}

export const checkoutTariff = {
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

