import { PaginationParamsSchema } from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema } from './shared.js'

/**
 * The deployment's model catalogue as an owner governs it.
 *
 * Distinct from `InferenceModelRecord` on purpose: that record is one local
 * `inference_models` row, and this is one **Ledger pair**, with the local row's
 * opinion folded in where one exists. The list is Ledger's, so a row here may
 * have no database identity at all.
 */
export const DeploymentModelRecordSchema = z.object({
  /** Agents in this organisation currently pinned to this exact pair. */
  agentCount: z.number().int().nonnegative(),
  description: z.string().optional(),
  displayName: NonEmptyStringSchema,
  /** False only when an owner has explicitly switched this pair off. */
  enabled: z.boolean(),
  /** True once a local row records a decision; false means "Ledger default". */
  hasLocalDecision: z.boolean(),
  model: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
  providerDisplayName: NonEmptyStringSchema,
})
export type DeploymentModelRecord = z.infer<typeof DeploymentModelRecordSchema>

export const DeploymentModelCatalogQuerySchema = PaginationParamsSchema
export type DeploymentModelCatalogQuery = z.infer<typeof DeploymentModelCatalogQuerySchema>

export const SetDeploymentModelEnabledBodySchema = z.object({
  enabled: z.boolean(),
  model: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
})
export type SetDeploymentModelEnabledBody = z.infer<
  typeof SetDeploymentModelEnabledBodySchema
>

export const TestInferenceModelBodySchema = z.object({
  model: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
})
export type TestInferenceModelBody = z.infer<typeof TestInferenceModelBodySchema>

/**
 * A test that reached the provider and a test that did not are both *results*,
 * never an exception the page swallows: an owner has to be able to tell a bad
 * key from a retired model from a timeout, and only the provider's own words
 * do that.
 */
export const InferenceModelTestResultSchema = z.object({
  failure: z
    .object({ code: NonEmptyStringSchema, message: NonEmptyStringSchema })
    .optional(),
  latencyMs: z.number().int().nonnegative(),
  model: NonEmptyStringSchema,
  ok: z.boolean(),
  provider: NonEmptyStringSchema,
  /** The model's own words. Absent when `ok` is false. */
  reply: z.string().optional(),
})
export type InferenceModelTestResult = z.infer<typeof InferenceModelTestResultSchema>
