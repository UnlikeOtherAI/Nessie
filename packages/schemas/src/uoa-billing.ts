import { z } from 'zod'

const ExactDecimalSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/)
const MinorAmountSchema = z.string().regex(/^\d+$/)

export const UoaBillingTariffSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  version: z.number().int().nonnegative(),
  mode: z.enum(['standard', 'free', 'at_cost', 'custom']),
  collection_mode: z.enum(['stripe', 'manual', 'none']),
  markup_bps: z.number().int().nonnegative(),
  markup_percent: ExactDecimalSchema,
  usage_price_multiplier_bps: z.number().int().nonnegative(),
  monthly_subscription: z.object({
    amount_minor: MinorAmountSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  usage_billing_enabled: z.boolean(),
  payment_collection_enabled: z.boolean(),
  raw_usage_preserved: z.literal(true),
})
export type UoaBillingTariff = z.infer<typeof UoaBillingTariffSchema>

const UoaBillingSubjectSchema = z.object({
  user_id: z.string().min(1),
  organisation_id: z.string().min(1),
  team_id: z.string().min(1),
})

const UoaBillingAssignmentSchema = z.object({
  scope: z.enum(['team', 'organisation', 'service_default']),
  id: z.string().min(1).nullable(),
})

export const UoaBillingSubscriptionSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  scope: z.enum(['organisation', 'team']),
  scope_key: z.string().min(1),
  tariff_id: z.string().min(1),
  cancel_at_period_end: z.boolean(),
  current_period_start: z.string().datetime().nullable(),
  current_period_end: z.string().datetime().nullable(),
  billing_phase: z.enum([
    'calendar_month',
    'free_alignment_period',
    'unknown',
  ]),
  created_at: z.string().datetime(),
  synced_at: z.string().datetime(),
})

export const UoaBillingSubscriptionSummarySchema = z.object({
  product: z.object({
    id: z.string().min(1),
    identifier: z.literal('nessie'),
  }),
  subject: UoaBillingSubjectSchema,
  tariff: UoaBillingTariffSchema,
  assignment: UoaBillingAssignmentSchema,
  stripe_collection_enabled: z.boolean(),
  stripe_mode: z.enum(['test', 'live']).nullable(),
  can_manage: z.boolean(),
  subscription: UoaBillingSubscriptionSchema.nullable(),
})
export type UoaBillingSubscriptionSummary = z.infer<
  typeof UoaBillingSubscriptionSummarySchema
>

export const UoaBillingCheckoutResponseSchema = z.object({
  checkout_session_id: z.string().min(1),
  checkout_url: z.string().url(),
  expires_at: z.string().datetime(),
  tariff: UoaBillingTariffSchema,
})
export type UoaBillingCheckoutResponse = z.infer<
  typeof UoaBillingCheckoutResponseSchema
>

export const UoaBillingPortalResponseSchema = z.object({
  portal_url: z.string().url(),
})
export type UoaBillingPortalResponse = z.infer<
  typeof UoaBillingPortalResponseSchema
>
