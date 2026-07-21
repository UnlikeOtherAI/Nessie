import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  billingCancellationConfirmationV1JsonSchema,
  billingCancellationConfirmRequestJsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingHostedRedirectResponseJsonSchema,
  billingStatementV2JsonSchema,
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
