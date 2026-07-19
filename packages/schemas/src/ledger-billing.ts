import { z } from 'zod'

const ExactDecimalSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/)
const NullableExactDecimalSchema = ExactDecimalSchema.nullable()
const NullableProductSchema = z.string().min(1).nullable()

export const LedgerBillingGroupBySchema = z.enum(['service', 'team', 'user'])
export type LedgerBillingGroupBy = z.infer<typeof LedgerBillingGroupBySchema>

export const LedgerBillingMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)

const ProviderUsageSchema = z.object({
  unitsIn: z.number().int().nonnegative(),
  unitsCachedIn: z.number().int().nonnegative(),
  unitsOut: z.number().int().nonnegative(),
})

const BillableUsageSchema = z.object({
  unitsIn: NullableExactDecimalSchema,
  unitsCachedIn: NullableExactDecimalSchema,
  unitsOut: NullableExactDecimalSchema,
})

const UsageIdentitySchema = z.object({
  billingProduct: NullableProductSchema,
  callerProduct: NullableProductSchema,
  serviceId: z.string().min(1),
  usageUnit: z.string().min(1),
  customerBillableUnitLabel: z.string().min(1),
  ratingStatus: z.string().min(1),
})

const LedgerBillingUsageByServiceSchema = UsageIdentitySchema.extend({
  calls: z.number().int().nonnegative(),
  rawProviderUsage: ProviderUsageSchema,
  customerBillableUnits: BillableUsageSchema,
})

const LedgerBillingAmountSchema = z.object({
  billingProduct: NullableProductSchema,
  callerProduct: NullableProductSchema,
  ratingStatus: z.string().min(1),
  calls: z.number().int().nonnegative(),
  rawProviderCurrency: z.string().min(1).nullable(),
  rawProviderEstimatedCost: NullableExactDecimalSchema,
  rawProviderActualCost: NullableExactDecimalSchema,
  billingBaseCurrency: z.string().min(1).nullable(),
  billingBaseAmount: NullableExactDecimalSchema,
  billingMarkupAmount: NullableExactDecimalSchema,
  customerChargeCurrency: z.string().min(1).nullable(),
  customerCharge: NullableExactDecimalSchema,
})

const LedgerBillingCustomerChargeSchema = z.object({
  billingProduct: NullableProductSchema,
  callerProduct: NullableProductSchema,
  currency: z.string().min(1),
  amount: NullableExactDecimalSchema,
  calls: z.number().int().nonnegative(),
})

export const LedgerBillingBreakdownSchema = UsageIdentitySchema
  .merge(LedgerBillingAmountSchema)
  .extend({
    dimension: z.string().nullable(),
    rawProviderUsage: ProviderUsageSchema,
    customerBillableUnits: BillableUsageSchema,
  })
export type LedgerBillingBreakdown = z.infer<
  typeof LedgerBillingBreakdownSchema
>

const LedgerBillingMonthlyComponentSchema = z.object({
  billingProduct: NullableProductSchema,
  callerProduct: NullableProductSchema,
  tariffId: z.string().min(1).nullable(),
  tariffKey: z.string().min(1).nullable(),
  tariffVersion: z.number().int().nonnegative().nullable(),
  tariffMode: z.string().min(1).nullable(),
  markupBps: z.number().int().nullable(),
  markupPercent: NullableExactDecimalSchema,
  usageMultiplierBps: z.number().int().nullable(),
  assignmentScope: z.string().min(1).nullable(),
  assignmentId: z.string().min(1).nullable(),
  amountMinor: z.string().regex(/^-?\d+$/).nullable(),
  currency: z.string().min(1).nullable(),
  usageBillingEnabled: z.boolean().nullable(),
  collectionMode: z.string().min(1).nullable(),
  paymentCollectionEnabled: z.boolean().nullable(),
  observedCalls: z.number().int().nonnegative(),
})

export const LedgerBillingUsageResponseSchema = z.object({
  schemaVersion: z.literal(4),
  product: z.string().min(1),
  scope: z.object({
    organizationId: z.string().min(1),
    teamId: z.string().min(1).nullable(),
    userId: z.string().min(1).nullable(),
    month: LedgerBillingMonthSchema,
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
  }),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    usageByService: z.array(LedgerBillingUsageByServiceSchema),
    amounts: z.array(LedgerBillingAmountSchema),
    customerCharges: z.array(LedgerBillingCustomerChargeSchema),
  }),
  groupBy: LedgerBillingGroupBySchema,
  breakdown: z.array(LedgerBillingBreakdownSchema),
  monthlyComponents: z.array(LedgerBillingMonthlyComponentSchema),
  snapshot: z.object({
    cursor: z.string().min(1),
    capturedAt: z.string().min(1),
    immutable: z.literal(true),
  }),
})
export type LedgerBillingUsageResponse = z.infer<
  typeof LedgerBillingUsageResponseSchema
>

export const NessieBillingUsageViewSchema = LedgerBillingUsageResponseSchema.extend({
  display: z.object({
    dimensionLabels: z.record(z.string(), z.string()),
    organizationName: z.string().min(1),
    teamName: z.string().min(1),
  }),
})
export type NessieBillingUsageView = z.infer<
  typeof NessieBillingUsageViewSchema
>
