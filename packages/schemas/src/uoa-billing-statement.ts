import { z } from 'zod'

const ExactDecimalSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
const NonNegativeDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
const WholeNumberSchema = z.string().regex(/^(?:0|[1-9]\d*)$/)
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/)

export const UoaExactMoneySchema = z
  .object({
    amount: ExactDecimalSchema,
    currency: CurrencySchema,
    display: z.string(),
  })
  .strict()
export type UoaExactMoney = z.infer<typeof UoaExactMoneySchema>

const UoaUsageUnitsSchema = z
  .object({
    input: NonNegativeDecimalSchema,
    cached_input: NonNegativeDecimalSchema,
    output: NonNegativeDecimalSchema,
    total: NonNegativeDecimalSchema,
  })
  .strict()

const UoaBillingSubjectSchema = z
  .object({
    user_id: z.string().min(1),
    organisation_id: z.string().min(1),
    team_id: z.string().min(1),
  })
  .strict()

export const UoaBillingStatementActionSchema = z
  .object({
    id: z.enum(['upgrade', 'portal', 'cancel']),
    kind: z.enum(['hosted_redirect', 'confirmation_dialog']),
    label: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    disabled_reason: z.string().nullable(),
    request: z
      .object({
        method: z.literal('POST'),
        path: z.string(),
        body: z.record(z.string()),
      })
      .strict(),
  })
  .strict()
export type UoaBillingStatementAction = z.infer<
  typeof UoaBillingStatementActionSchema
>

export const UoaBillingStatementV1Schema = z
  .object({
    schema_version: z.literal(1),
    statement_id: z.string().regex(/^bst_[A-Za-z0-9_-]+$/),
    generated_at: z.string().datetime(),
    product: z
      .object({
        id: z.string(),
        identifier: z.string(),
        name: z.string(),
      })
      .strict(),
    subject: UoaBillingSubjectSchema,
    period: z
      .object({
        key: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime(),
        state: z.enum(['open', 'closed']),
      })
      .strict(),
    pinned_inputs: z
      .object({
        ledger_snapshots: z
          .array(
            z
              .object({
                group_by: z.enum(['service', 'user']),
                cursor: z.string(),
                id: z.string(),
                captured_at: z.string().datetime(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          )
          .length(2),
        tariff: z
          .object({
            id: z.string(),
            version: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    plan: z
      .object({
        tariff_id: z.string(),
        key: z.string(),
        version: z.number().int().positive(),
        name: z.string(),
        display_name: z.string(),
        mode: z.enum(['standard', 'free', 'at_cost', 'custom']),
        collection_mode: z.enum(['stripe', 'manual', 'none']),
        markup_bps: z.number().int().nonnegative(),
        markup_percent: z.string(),
        markup_display: z.string(),
        usage_multiplier_bps: z.number().int().nonnegative(),
        monthly_subscription: UoaExactMoneySchema.extend({
          amount_minor: WholeNumberSchema,
        }).strict(),
        assignment: z
          .object({
            scope: z.enum(['team', 'organisation', 'service_default']),
            id: z.string().nullable(),
          })
          .strict(),
      })
      .strict(),
    collection: z
      .object({
        payment_collection_enabled: z.boolean(),
        stripe_collection_enabled: z.boolean(),
        stripe_mode: z.enum(['test', 'live']).nullable(),
      })
      .strict(),
    subscription: z
      .object({
        id: z.string(),
        status: z.string(),
        display_status: z.string(),
        scope: z.enum(['team', 'organisation']),
        cancel_at_period_end: z.boolean(),
        current_period_start: z.string().datetime().nullable(),
        current_period_end: z.string().datetime().nullable(),
      })
      .strict()
      .nullable(),
    services: z.array(
      z
        .object({
          product: z.string(),
          name: z.string().nullable(),
          display_name: z.string(),
          access: z.enum(['direct', 'indirect']),
          direct_user_count: z.number().int().nonnegative(),
          roles: z.array(
            z.enum([
              'billing_product',
              'caller_product',
              'origin_product',
            ]),
          ),
        })
        .strict(),
    ),
    usage: z
      .object({
        lines: z.array(
          z
            .object({
              id: z.string(),
              service_id: z.string(),
              usage_unit: z.string(),
              calls: WholeNumberSchema,
              attribution: z
                .object({
                  user_id: z.string().nullable(),
                  billing_product: z.string(),
                  caller_product: z.string(),
                  origin_product: z.string(),
                })
                .strict(),
              raw_units: UoaUsageUnitsSchema,
              billable_units: UoaUsageUnitsSchema,
              share: z
                .object({
                  basis_points: z.number().int().min(0).max(10_000),
                  percent: z.string(),
                  display: z.string(),
                })
                .strict(),
              provider_cost: UoaExactMoneySchema.extend({
                provenance: z.string(),
              })
                .strict()
                .nullable(),
              rated_charge: z
                .object({
                  base: UoaExactMoneySchema,
                  markup: UoaExactMoneySchema,
                  total: UoaExactMoneySchema,
                })
                .strict()
                .nullable(),
            })
            .strict(),
        ),
        totals: z.array(
          z
            .object({
              usage_unit: z.string(),
              raw_units: z.string(),
              billable_units: z.string(),
              display: z.string(),
            })
            .strict(),
        ),
        cost_totals: z.array(
          z
            .object({
              currency: CurrencySchema,
              provider_cost: UoaExactMoneySchema,
              markup: UoaExactMoneySchema,
              usage_charge: UoaExactMoneySchema,
            })
            .strict(),
        ),
        user_totals: z.array(
          z
            .object({
              user_id: z.string(),
              name: z.string().nullable(),
              email: z.string(),
              calls: WholeNumberSchema,
              usage: z.array(
                z
                  .object({
                    usage_unit: z.string(),
                    raw_units: z.string(),
                    billable_units: z.string(),
                  })
                  .strict(),
              ),
              costs: z.array(
                z
                  .object({
                    currency: CurrencySchema,
                    provider_cost: UoaExactMoneySchema,
                    markup: UoaExactMoneySchema,
                    usage_charge: UoaExactMoneySchema,
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
    commercial_lines: z.array(
      z
        .object({
          id: z.string(),
          kind: z.enum([
            'monthly_subscription',
            'usage',
            'add_on',
            'credit',
          ]),
          product: z.string(),
          label: z.string(),
          detail: z.string(),
          amount: UoaExactMoneySchema,
        })
        .strict(),
    ),
    totals: z.array(
      z
        .object({
          currency: CurrencySchema,
          monthly: UoaExactMoneySchema,
          usage: UoaExactMoneySchema,
          add_ons: UoaExactMoneySchema,
          credits: UoaExactMoneySchema,
          total_due: UoaExactMoneySchema,
        })
        .strict(),
    ),
    capabilities: z
      .object({
        can_upgrade: z.boolean(),
        can_open_portal: z.boolean(),
        can_cancel: z.boolean(),
      })
      .strict(),
    actions: z.array(UoaBillingStatementActionSchema),
  })
  .strict()
export type UoaBillingStatementV1 = z.infer<
  typeof UoaBillingStatementV1Schema
>

