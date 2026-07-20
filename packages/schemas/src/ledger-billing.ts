import { z } from 'zod'

const ExactDecimalSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/)
const NullableExactDecimalSchema = ExactDecimalSchema.nullable()
const NullableProductSchema = z.string().min(1).nullable()
const NullableStringSchema = z.string().min(1).nullable()

export const LedgerBillingGroupBySchema = z.enum(['service', 'team', 'user'])
export type LedgerBillingGroupBy = z.infer<typeof LedgerBillingGroupBySchema>

export const LedgerBillingMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)

const ProviderUsageSchema = z
  .object({
    unitsIn: z.number().int().nonnegative(),
    unitsCachedIn: z.number().int().nonnegative(),
    unitsOut: z.number().int().nonnegative(),
  })
  .passthrough()

const BillableUsageSchema = z
  .object({
    unitsIn: NullableExactDecimalSchema,
    unitsCachedIn: NullableExactDecimalSchema,
    unitsOut: NullableExactDecimalSchema,
  })
  .passthrough()

const ProductDimensionsSchema = z
  .object({
    billingProduct: NullableProductSchema,
    callerProduct: NullableProductSchema,
    originProduct: NullableProductSchema,
  })
  .passthrough()

const TariffPeriodSchema = z
  .object({
    tariffId: NullableStringSchema,
    tariffVersion: z.number().int().nonnegative().nullable(),
    assignmentScope: z
      .enum(['team', 'organisation', 'service_default'])
      .nullable(),
    assignmentId: NullableStringSchema,
    collectionMode: z.enum(['stripe', 'manual', 'none']).nullable(),
    paymentCollectionEnabled: z.boolean().nullable(),
    stripeCollectible: z.boolean(),
  })
  .passthrough()

const UsageIdentitySchema = ProductDimensionsSchema.extend({
  serviceId: z.string().min(1),
  usageUnit: z.string().min(1),
  customerBillableUnitLabel: z.string().min(1),
  ratingStatus: z.string().min(1),
}).passthrough()

const LedgerBillingUsageByServiceSchema = UsageIdentitySchema.extend({
  calls: z.number().int().nonnegative(),
  rawProviderUsage: ProviderUsageSchema,
  customerBillableUnits: BillableUsageSchema,
})

const LedgerBillingAmountSchema = ProductDimensionsSchema
  .merge(TariffPeriodSchema)
  .extend({
    ratingStatus: z.string().min(1),
    calls: z.number().int().nonnegative(),
    rawProviderCurrency: NullableStringSchema,
    rawProviderEstimatedCost: NullableExactDecimalSchema,
    rawProviderActualCost: NullableExactDecimalSchema,
    billingBaseCurrency: NullableStringSchema,
    billingBaseAmount: NullableExactDecimalSchema,
    billingMarkupAmount: NullableExactDecimalSchema,
    customerChargeCurrency: NullableStringSchema,
    customerCharge: NullableExactDecimalSchema,
  })
  .passthrough()

const LedgerBillingCustomerChargeSchema = ProductDimensionsSchema
  .merge(TariffPeriodSchema)
  .extend({
    currency: NullableStringSchema,
    amount: NullableExactDecimalSchema,
    calls: z.number().int().nonnegative(),
  })
  .passthrough()

export const LedgerBillingBreakdownSchema = UsageIdentitySchema
  .merge(LedgerBillingAmountSchema)
  .extend({
    dimension: z.string().nullable(),
    rawProviderUsage: ProviderUsageSchema,
    customerBillableUnits: BillableUsageSchema,
  })
  .passthrough()
export type LedgerBillingBreakdown = z.infer<
  typeof LedgerBillingBreakdownSchema
>

const LedgerBillingMonthlyComponentSchema = ProductDimensionsSchema
  .merge(TariffPeriodSchema)
  .extend({
    tariffKey: NullableStringSchema,
    tariffMode: NullableStringSchema,
    markupBps: z.number().int().nullable(),
    markupPercent: NullableExactDecimalSchema,
    usageMultiplierBps: z.number().int().nullable(),
    amountMinor: z.string().regex(/^-?\d+$/).nullable(),
    currency: NullableStringSchema,
    usageBillingEnabled: z.boolean().nullable(),
    observedCalls: z.number().int().nonnegative(),
  })
  .passthrough()

export const LedgerBillingUsageResponseSchema = z
  .object({
    schemaVersion: z.literal(4),
    product: z.string().min(1),
    scope: z
      .object({
        organizationId: z.string().min(1),
        teamId: z.string().min(1).nullable(),
        userId: z.string().min(1).nullable(),
        month: LedgerBillingMonthSchema,
        startsAt: z.string().min(1),
        endsAt: z.string().min(1),
      })
      .passthrough(),
    totals: z
      .object({
        calls: z.number().int().nonnegative(),
        usageByService: z.array(LedgerBillingUsageByServiceSchema),
        amounts: z.array(LedgerBillingAmountSchema),
        customerCharges: z.array(LedgerBillingCustomerChargeSchema),
      })
      .passthrough(),
    groupBy: LedgerBillingGroupBySchema,
    breakdown: z.array(LedgerBillingBreakdownSchema),
    monthlyComponents: z.array(LedgerBillingMonthlyComponentSchema),
    snapshot: z
      .object({
        cursor: z.string().min(1),
        capturedAt: z.string().min(1),
        immutable: z.literal(true),
      })
      .passthrough(),
  })
  .passthrough()
export type LedgerBillingUsageResponse = z.infer<
  typeof LedgerBillingUsageResponseSchema
>

export const NessieBillingUsageViewSchema = LedgerBillingUsageResponseSchema.extend({
  display: z
    .object({
      dimensionLabels: z.record(z.string(), z.string()),
      organizationName: z.string().min(1),
      teamName: z.string().min(1),
    })
    .passthrough(),
})
export type NessieBillingUsageView = z.infer<
  typeof NessieBillingUsageViewSchema
>
