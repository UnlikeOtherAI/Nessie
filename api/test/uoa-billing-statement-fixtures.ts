import { generateKeyPairSync } from 'node:crypto'

import {
  NESSIE_UOA_BILLING_ACTOR_KEY_ENV,
  NESSIE_UOA_BILLING_APP_KEY_ENV,
} from '../src/services/uoa-billing-client.js'

export const actorContext = {
  actionContext: {
    correlationId: 'correlation-1',
    requestId: 'request-1',
    uoaIdentity: {
      organizationId: 'uoa-org',
      subject: 'uoa-user',
      teamId: 'uoa-team',
      tokenVersion: 7,
    },
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
  uoaTokenVersion?: number | null
} = {}) => ({
  productAccountLink: {
    findUnique: async () => ({
      activeOrgId: overrides.activeOrgId ?? 'uoa-org',
      activeTeamId: 'uoa-team',
      status: 'linked',
      uoaSub: 'uoa-user',
      uoaTokenVersion: Object.hasOwn(overrides, 'uoaTokenVersion')
        ? overrides.uoaTokenVersion ?? null
        : 7,
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
  schema_version: 2,
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
        contract: 'metering-portfolio-v1',
        group_by: 'user',
        cursor: 'mup_1123456789ABCDEFGHIJKLMNOPQRSTUV',
        id: 'mup_1123456789ABCDEFGHIJKLMNOPQRSTUV',
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
  connected_service_usage: {
    title: 'Connected-service usage',
    description:
      'Team-wide raw usage across connected services. Other services are shown for transparency and are not added to this statement total.',
    statement_product: 'nessie',
    services: [
      {
        billing_product: 'deepwater',
        name: 'DeepWater',
        display_name: 'DeepWater',
        access: 'indirect',
        direct_user_count: 0,
        title: 'DeepWater team usage',
        description:
          'DeepWater used 1,000 raw tokens across this team. DeepWater originated 56%; Nessie originated 44%.',
        totals: {
          calls: '10',
          usage: [{
            usage_unit: 'tokens',
            raw_units: '1000',
            display: '1,000 raw tokens across this team',
          }],
          provider_costs: [{
            currency: 'USD',
            provider_cost: money('10.00', '$10.00'),
            display: '$10.00 raw provider cost across this team',
          }],
        },
        origins: [
          {
            product: 'deepwater',
            name: 'DeepWater',
            display_name: 'DeepWater',
            is_statement_product: false,
            calls: '6',
            call_share: {
              basis_points: 6_000,
              percent: '60.00',
              display: '60% of DeepWater calls',
            },
            usage: [{
              usage_unit: 'tokens',
              raw_units: '560',
              share: {
                basis_points: 5_600,
                percent: '56.00',
                display: '56% of DeepWater tokens',
              },
              display: 'DeepWater originated 560 raw tokens (56%)',
            }],
            provider_costs: [{
              currency: 'USD',
              provider_cost: money('5.60', '$5.60'),
              share: {
                basis_points: 5_600,
                percent: '56.00',
                display: '56% of DeepWater USD provider cost',
              },
              display: 'DeepWater originated $5.60 raw provider cost (56%)',
            }],
          },
          {
            product: 'nessie',
            name: 'Nessie',
            display_name: 'Nessie',
            is_statement_product: true,
            calls: '4',
            call_share: {
              basis_points: 4_000,
              percent: '40.00',
              display: '40% of DeepWater calls',
            },
            usage: [{
              usage_unit: 'tokens',
              raw_units: '440',
              share: {
                basis_points: 4_400,
                percent: '44.00',
                display: '44% of DeepWater tokens',
              },
              display: 'Nessie originated 440 raw tokens (44%)',
            }],
            provider_costs: [{
              currency: 'USD',
              provider_cost: money('4.40', '$4.40'),
              share: {
                basis_points: 4_400,
                percent: '44.00',
                display: '44% of DeepWater USD provider cost',
              },
              display: 'Nessie originated $4.40 raw provider cost (44%)',
            }],
          },
        ],
        users: [{
          user_id: 'uoa-user',
          name: 'Ada',
          email: 'ada@example.com',
          display_name: 'Ada',
          calls: '10',
          call_share: {
            basis_points: 10_000,
            percent: '100.00',
            display: '100% of DeepWater calls',
          },
          usage: [{
            usage_unit: 'tokens',
            raw_units: '1000',
            share: {
              basis_points: 10_000,
              percent: '100.00',
              display: '100% of DeepWater tokens',
            },
            display: 'Ada used 1,000 raw tokens (100%)',
          }],
          provider_costs: [{
            currency: 'USD',
            provider_cost: money('10.00', '$10.00'),
            share: {
              basis_points: 10_000,
              percent: '100.00',
              display: '100% of DeepWater USD provider cost',
            },
            display: 'Ada used $10.00 raw provider cost (100%)',
          }],
        }],
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
