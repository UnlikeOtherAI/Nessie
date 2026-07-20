import { z } from 'zod'

export const UoaBillingCancellationSelectionSchema = z.enum([
  'current_service',
  'current_and_related_direct_services',
])
export type UoaBillingCancellationSelection = z.infer<
  typeof UoaBillingCancellationSelectionSchema
>

export const UoaBillingCancellationPreviewV1Schema = z
  .object({
    schema_version: z.literal(1),
    preview_token: z.string().min(32).max(256),
    expires_at: z.string().datetime(),
    title: z.string(),
    message: z.string(),
    choice_required: z.boolean(),
    choices: z.array(
      z
        .object({
          id: UoaBillingCancellationSelectionSchema,
          label: z.string(),
          description: z.string(),
          service_ids: z.array(z.string()),
        })
        .strict(),
    ),
    direct_services: z.array(
      z
        .object({
          service_id: z.string(),
          product: z.string(),
          name: z.string(),
          display_name: z.string(),
          direct_user_count: z.number().int().nonnegative(),
          subscription_status: z.string(),
        })
        .strict(),
    ),
    indirect_services: z.array(
      z
        .object({
          product: z.string(),
          name: z.string().nullable(),
          display_name: z.string(),
          impact: z.string(),
        })
        .strict(),
    ),
    confirm_action: z
      .object({
        method: z.literal('POST'),
        path: z.literal('/billing/v1/cancellation/confirm'),
        label: z.string(),
        idempotency_key: z.string().min(16).max(200),
        selection_required: z.boolean(),
        default_selection: z.literal('current_service').nullable(),
      })
      .strict(),
  })
  .strict()
export type UoaBillingCancellationPreviewV1 = z.infer<
  typeof UoaBillingCancellationPreviewV1Schema
>

export const UoaBillingCancellationConfirmRequestSchema = z
  .object({
    preview_token: z.string().min(32).max(256),
    idempotency_key: z.string().min(16).max(200),
    selection: UoaBillingCancellationSelectionSchema.nullable(),
  })
  .strict()
export type UoaBillingCancellationConfirmRequest = z.infer<
  typeof UoaBillingCancellationConfirmRequestSchema
>

export const UoaBillingCancellationConfirmationV1Schema = z
  .object({
    schema_version: z.literal(1),
    status: z.literal('confirmed'),
    title: z.string(),
    message: z.string(),
    cancelled_services: z.array(
      z
        .object({
          service_id: z.string(),
          product: z.string(),
          name: z.string(),
          display_name: z.string(),
          status: z.string(),
          effective_at: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    indirect_services: z.array(
      z
        .object({
          product: z.string(),
          display_name: z.string(),
          impact: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
export type UoaBillingCancellationConfirmationV1 = z.infer<
  typeof UoaBillingCancellationConfirmationV1Schema
>

