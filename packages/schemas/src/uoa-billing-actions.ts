import { z } from 'zod'

const ExactDecimalSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/)
const MinorAmountSchema = z.string().regex(/^\d+$/)

const CheckoutTariffSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().min(1),
    version: z.number().int().nonnegative(),
    mode: z.enum(['standard', 'free', 'at_cost', 'custom']),
    collection_mode: z.enum(['stripe', 'manual', 'none']),
    markup_bps: z.number().int().nonnegative(),
    markup_percent: ExactDecimalSchema,
    usage_price_multiplier_bps: z.number().int().nonnegative(),
    monthly_subscription: z
      .object({
        amount_minor: MinorAmountSchema,
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    usage_billing_enabled: z.boolean(),
    payment_collection_enabled: z.boolean(),
    raw_usage_preserved: z.literal(true),
  })
  .strict()

export const UoaBillingCheckoutResponseSchema = z
  .object({
    checkout_session_id: z.string().min(1),
    checkout_url: z.string().url(),
    expires_at: z.string().datetime(),
    tariff: CheckoutTariffSchema,
  })
  .strict()

export const UoaBillingPortalResponseSchema = z
  .object({
    portal_url: z.string().url(),
  })
  .strict()
