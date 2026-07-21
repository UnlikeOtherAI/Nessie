import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  billingCancellationConfirmationV1JsonSchema,
  billingCancellationConfirmRequestJsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingHostedRedirectResponseJsonSchema,
  billingCreditsV1JsonSchema,
  billingRecurringAddonCancellationConfirmationV1JsonSchema,
  billingRecurringAddonCancellationConfirmRequestV1JsonSchema,
  billingRecurringAddonCancellationPreviewV1JsonSchema,
  billingRecurringAddonsV1JsonSchema,
  billingStatementV2JsonSchema,
  type BillingCreditsV1,
  type BillingRecurringAddonCancellationConfirmationV1,
  type BillingRecurringAddonCancellationConfirmRequestV1,
  type BillingRecurringAddonCancellationPreviewV1,
  type BillingRecurringAddonsV1,
  type BillingCancellationConfirmationV1,
  type BillingCancellationConfirmRequest,
  type BillingCancellationPreviewV1,
  type BillingHostedRedirectResponse,
  type BillingStatementV2,
} from '@unlikeotherai/billing-statement-protocol'

const ajv = new Ajv2020.default({ allErrors: true, strict: true })
addFormats.default(ajv)

const statementValidator = ajv.compile<BillingStatementV2>(
  billingStatementV2JsonSchema,
)
const creditsValidator = ajv.compile<BillingCreditsV1>(
  billingCreditsV1JsonSchema,
)
const recurringAddonsValidator = ajv.compile<BillingRecurringAddonsV1>(
  billingRecurringAddonsV1JsonSchema,
)
const recurringAddonCancellationPreviewValidator =
  ajv.compile<BillingRecurringAddonCancellationPreviewV1>(
    billingRecurringAddonCancellationPreviewV1JsonSchema,
  )
const recurringAddonCancellationConfirmRequestValidator =
  ajv.compile<BillingRecurringAddonCancellationConfirmRequestV1>(
    billingRecurringAddonCancellationConfirmRequestV1JsonSchema,
  )
const recurringAddonCancellationConfirmationValidator =
  ajv.compile<BillingRecurringAddonCancellationConfirmationV1>(
    billingRecurringAddonCancellationConfirmationV1JsonSchema,
  )
const hostedRedirectValidator = ajv.compile<BillingHostedRedirectResponse>(
  billingHostedRedirectResponseJsonSchema,
)
const cancellationPreviewValidator = ajv.compile<BillingCancellationPreviewV1>(
  billingCancellationPreviewV1JsonSchema,
)
const cancellationConfirmRequestValidator =
  ajv.compile<BillingCancellationConfirmRequest>(
    billingCancellationConfirmRequestJsonSchema,
  )
const cancellationConfirmationValidator =
  ajv.compile<BillingCancellationConfirmationV1>(
    billingCancellationConfirmationV1JsonSchema,
  )

const parseWith = <T>(
  validator: ValidateFunction<T>,
  value: unknown,
): T | null => (validator(value) ? value : null)

export const parseBillingStatementV2 = (
  value: unknown,
): BillingStatementV2 | null => parseWith(statementValidator, value)

export const parseBillingCreditsV1 = (
  value: unknown,
): BillingCreditsV1 | null => parseWith(creditsValidator, value)

export const parseBillingRecurringAddonsV1 = (
  value: unknown,
): BillingRecurringAddonsV1 | null => parseWith(recurringAddonsValidator, value)

export const parseBillingRecurringAddonCancellationPreviewV1 = (
  value: unknown,
): BillingRecurringAddonCancellationPreviewV1 | null =>
  parseWith(recurringAddonCancellationPreviewValidator, value)

export const parseBillingRecurringAddonCancellationConfirmRequestV1 = (
  value: unknown,
): BillingRecurringAddonCancellationConfirmRequestV1 | null =>
  parseWith(recurringAddonCancellationConfirmRequestValidator, value)

export const parseBillingRecurringAddonCancellationConfirmationV1 = (
  value: unknown,
): BillingRecurringAddonCancellationConfirmationV1 | null =>
  parseWith(recurringAddonCancellationConfirmationValidator, value)

export const parseBillingHostedRedirectResponse = (
  value: unknown,
): BillingHostedRedirectResponse | null =>
  parseWith(hostedRedirectValidator, value)

export const parseBillingCancellationPreviewV1 = (
  value: unknown,
): BillingCancellationPreviewV1 | null =>
  parseWith(cancellationPreviewValidator, value)

export const parseBillingCancellationConfirmRequest = (
  value: unknown,
): BillingCancellationConfirmRequest | null =>
  parseWith(cancellationConfirmRequestValidator, value)

export const parseBillingCancellationConfirmationV1 = (
  value: unknown,
): BillingCancellationConfirmationV1 | null =>
  parseWith(cancellationConfirmationValidator, value)
