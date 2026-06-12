import { OrganizationIdSchema } from '@nessie/schemas'
import { z } from 'zod'

import {
  EvalCaseResultSchema,
  EvalDatasetRefSchema,
  EvalSummarySchema,
  InferenceCapabilitySourceSchema,
  InferenceConnectorKindSchema,
  InferenceEvalStatusSchema,
  InferenceExposureSchema,
  InferenceHealthStatusSchema,
  InferenceLifecycleStatusSchema,
  InferenceRoutingModeSchema,
  InferenceStreamPolicySchema,
  ModelCapabilitySnapshotSchema,
  RouteGraphSchema,
} from './inference-core.js'
import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const InferenceProviderRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerKey: NonEmptyStringSchema,
  connectorKind: InferenceConnectorKindSchema,
  displayName: NonEmptyStringSchema,
  enabled: z.boolean(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  baseUrl: z.string().min(1).optional(),
  supportsModelDiscovery: z.boolean(),
  activeCredentialBindingId: z.string().uuid().optional(),
  healthStatus: InferenceHealthStatusSchema,
  lastCheckedAt: TimestampSchema.optional(),
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceProviderRecord = z.infer<typeof InferenceProviderRecordSchema>

export const CreateInferenceProviderBodySchema = z.object({
  providerKey: NonEmptyStringSchema,
  connectorKind: InferenceConnectorKindSchema,
  displayName: NonEmptyStringSchema,
  baseUrl: z.string().min(1).optional(),
  supportsModelDiscovery: z.boolean().optional(),
  enabled: z.boolean().optional(),
})
export type CreateInferenceProviderBody = z.infer<
  typeof CreateInferenceProviderBodySchema
>

export const UpdateInferenceProviderBodySchema = z.object({
  providerKey: NonEmptyStringSchema.optional(),
  connectorKind: InferenceConnectorKindSchema.optional(),
  displayName: NonEmptyStringSchema.optional(),
  baseUrl: z.string().min(1).nullable().optional(),
  supportsModelDiscovery: z.boolean().optional(),
  activeCredentialBindingId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
})
export type UpdateInferenceProviderBody = z.infer<
  typeof UpdateInferenceProviderBodySchema
>

export const SetInferenceProviderHealthBodySchema = z.object({
  healthStatus: InferenceHealthStatusSchema,
  lastCheckedAt: TimestampSchema.optional(),
})
export type SetInferenceProviderHealthBody = z.infer<
  typeof SetInferenceProviderHealthBodySchema
>

// Note: authSecretRef is intentionally omitted from the response record. It is
// accepted on create (CreateInferenceCredentialBindingBodySchema) and resolved
// server-side at inference time; clients never need it back, and returning it
// would needlessly disclose the secret reference.
export const InferenceCredentialBindingRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerId: z.string().uuid(),
  label: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  revokedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceCredentialBindingRecord = z.infer<
  typeof InferenceCredentialBindingRecordSchema
>

export const CreateInferenceCredentialBindingBodySchema = z.object({
  providerId: z.string().uuid(),
  label: NonEmptyStringSchema,
  authSecretRef: NonEmptyStringSchema,
})
export type CreateInferenceCredentialBindingBody = z.infer<
  typeof CreateInferenceCredentialBindingBodySchema
>

export const InferenceModelRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  displayName: z.string().optional(),
  enabled: z.boolean(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  capabilitySnapshot: ModelCapabilitySnapshotSchema,
  source: InferenceCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceModelRecord = z.infer<typeof InferenceModelRecordSchema>

export const CreateInferenceModelBodySchema = z.object({
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  displayName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  capabilitySnapshot: ModelCapabilitySnapshotSchema,
  source: InferenceCapabilitySourceSchema.optional(),
  discoveredAt: TimestampSchema.optional(),
  lastVerifiedAt: TimestampSchema.optional(),
})
export type CreateInferenceModelBody = z.infer<typeof CreateInferenceModelBodySchema>

export const UpdateInferenceModelBodySchema = z.object({
  displayName: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  capabilitySnapshot: ModelCapabilitySnapshotSchema.optional(),
  source: InferenceCapabilitySourceSchema.optional(),
  discoveredAt: TimestampSchema.optional(),
  lastVerifiedAt: TimestampSchema.nullable().optional(),
})
export type UpdateInferenceModelBody = z.infer<typeof UpdateInferenceModelBodySchema>

export const InferenceCapabilityOverrideRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  lifecycleStatus: InferenceLifecycleStatusSchema,
  overrideSnapshot: ModelCapabilitySnapshotSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  clearedAt: TimestampSchema.optional(),
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
})
export type InferenceCapabilityOverrideRecord = z.infer<
  typeof InferenceCapabilityOverrideRecordSchema
>

export const CreateInferenceCapabilityOverrideBodySchema = z.object({
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  overrideSnapshot: ModelCapabilitySnapshotSchema,
})
export type CreateInferenceCapabilityOverrideBody = z.infer<
  typeof CreateInferenceCapabilityOverrideBodySchema
>

export const UpdateInferenceCapabilityOverrideBodySchema = z.object({
  overrideSnapshot: ModelCapabilitySnapshotSchema.optional(),
  clearedAt: TimestampSchema.nullable().optional(),
})
export type UpdateInferenceCapabilityOverrideBody = z.infer<
  typeof UpdateInferenceCapabilityOverrideBodySchema
>

export const InferenceRoutingProfileRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  exposure: InferenceExposureSchema,
  lifecycleStatus: InferenceLifecycleStatusSchema,
  mode: InferenceRoutingModeSchema,
  streamPolicy: InferenceStreamPolicySchema,
  toolMediatorProfileId: z.string().uuid().optional(),
  routeGraph: RouteGraphSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceRoutingProfileRecord = z.infer<
  typeof InferenceRoutingProfileRecordSchema
>

export const CreateInferenceRoutingProfileBodySchema = z.object({
  label: NonEmptyStringSchema,
  enabled: z.boolean().optional(),
  exposure: InferenceExposureSchema.optional(),
  mode: InferenceRoutingModeSchema,
  streamPolicy: InferenceStreamPolicySchema.optional(),
  toolMediatorProfileId: z.string().uuid().optional(),
  routeGraph: RouteGraphSchema,
})
export type CreateInferenceRoutingProfileBody = z.infer<
  typeof CreateInferenceRoutingProfileBodySchema
>

export const UpdateInferenceRoutingProfileBodySchema = z.object({
  label: NonEmptyStringSchema.optional(),
  enabled: z.boolean().optional(),
  exposure: InferenceExposureSchema.optional(),
  mode: InferenceRoutingModeSchema.optional(),
  streamPolicy: InferenceStreamPolicySchema.optional(),
  toolMediatorProfileId: z.string().uuid().nullable().optional(),
  routeGraph: RouteGraphSchema.optional(),
})
export type UpdateInferenceRoutingProfileBody = z.infer<
  typeof UpdateInferenceRoutingProfileBodySchema
>

export const ToolMediatorProfileRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  translatorProvider: NonEmptyStringSchema,
  translatorModel: NonEmptyStringSchema,
  mediatorConfig: z.record(z.unknown()).default({}),
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ToolMediatorProfileRecord = z.infer<typeof ToolMediatorProfileRecordSchema>

export const CreateToolMediatorProfileBodySchema = z.object({
  label: NonEmptyStringSchema,
  enabled: z.boolean().optional(),
  translatorProvider: NonEmptyStringSchema,
  translatorModel: NonEmptyStringSchema,
  mediatorConfig: z.record(z.unknown()).optional(),
})
export type CreateToolMediatorProfileBody = z.infer<
  typeof CreateToolMediatorProfileBodySchema
>

export const UpdateToolMediatorProfileBodySchema = z.object({
  label: NonEmptyStringSchema.optional(),
  enabled: z.boolean().optional(),
  translatorProvider: NonEmptyStringSchema.optional(),
  translatorModel: NonEmptyStringSchema.optional(),
  mediatorConfig: z.record(z.unknown()).optional(),
})
export type UpdateToolMediatorProfileBody = z.infer<
  typeof UpdateToolMediatorProfileBodySchema
>

export const InferenceEvalSuiteRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  exposure: InferenceExposureSchema,
  enabled: z.boolean(),
  datasetRef: EvalDatasetRefSchema,
  targetRoutingProfileId: z.string().uuid(),
  judgeRoutingProfileId: z.string().uuid().optional(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceEvalSuiteRecord = z.infer<typeof InferenceEvalSuiteRecordSchema>

export const CreateInferenceEvalSuiteBodySchema = z.object({
  label: NonEmptyStringSchema,
  exposure: InferenceExposureSchema.optional(),
  enabled: z.boolean().optional(),
  datasetRef: EvalDatasetRefSchema,
  targetRoutingProfileId: z.string().uuid(),
  judgeRoutingProfileId: z.string().uuid().optional(),
})
export type CreateInferenceEvalSuiteBody = z.infer<
  typeof CreateInferenceEvalSuiteBodySchema
>

export const UpdateInferenceEvalSuiteBodySchema = z.object({
  label: NonEmptyStringSchema.optional(),
  exposure: InferenceExposureSchema.optional(),
  enabled: z.boolean().optional(),
  datasetRef: EvalDatasetRefSchema.optional(),
  targetRoutingProfileId: z.string().uuid().optional(),
  judgeRoutingProfileId: z.string().uuid().nullable().optional(),
})
export type UpdateInferenceEvalSuiteBody = z.infer<
  typeof UpdateInferenceEvalSuiteBodySchema
>

export const InferenceEvalRunRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  evalSuiteId: z.string().uuid(),
  startedByActorId: NonEmptyStringSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  status: InferenceEvalStatusSchema,
  summary: EvalSummarySchema,
  result: z.record(z.unknown()).default({}),
  caseResults: EvalCaseResultSchema.array(),
  targetProfileSnapshot: InferenceRoutingProfileRecordSchema,
  judgeProfileSnapshot: InferenceRoutingProfileRecordSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceEvalRunRecord = z.infer<typeof InferenceEvalRunRecordSchema>

export const CreateInferenceEvalRunBodySchema = z.object({
  evalSuiteId: z.string().uuid(),
})
export type CreateInferenceEvalRunBody = z.infer<typeof CreateInferenceEvalRunBodySchema>

export const UpdateInferenceEvalRunBodySchema = z.object({
  status: InferenceEvalStatusSchema.optional(),
  summary: EvalSummarySchema.optional(),
  result: z.record(z.unknown()).optional(),
  caseResults: EvalCaseResultSchema.array().optional(),
  targetProfileSnapshot: InferenceRoutingProfileRecordSchema.optional(),
  judgeProfileSnapshot: InferenceRoutingProfileRecordSchema.nullable().optional(),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.nullable().optional(),
})
export type UpdateInferenceEvalRunBody = z.infer<typeof UpdateInferenceEvalRunBodySchema>
