import { z } from 'zod'

import {
  InvocationRecordSchema,
  ModelCapabilitySnapshotSchema,
  ModelCapabilitySourceSchema,
  NormalizedFinishReasonSchema,
  ProviderHealthStatusSchema,
  ProviderMessageSchema,
  ProviderToolCallSchema,
  ToolCallIntentSchema,
  ToolCallingModeSchema,
  ToolSchemaDescriptorSchema,
  StructuredOutputDescriptorSchema,
  type CapabilityResolution,
  type InferenceRequest,
  type ModelCapabilitySnapshot,
  type ProviderConnectionConfig,
  type ProviderConnectorMeta,
  type ProviderHealthReport,
  type ProviderInvocationRequest,
  type ProviderInvocationResult,
  type ProviderStreamEvent,
  type ToolCallIntent,
} from './inference-core.js'
import {
  InferenceCredentialBindingIdSchema,
  InferenceModelIdSchema,
  InferenceProviderIdSchema,
  InferenceRoutingProfileIdSchema,
  OrganizationIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export const StageExecutionStatusSchema = z.enum([
  'started',
  'completed',
  'failed',
])
export type StageExecutionStatus = z.infer<typeof StageExecutionStatusSchema>

export const InferenceStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reasoning_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('output_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('stage.status'),
    stageId: NonEmptyStringSchema,
    status: StageExecutionStatusSchema,
  }),
])
export type InferenceStreamEvent = z.infer<typeof InferenceStreamEventSchema>

export const RoutingModeSchema = z.enum([
  'single',
  'fallback',
  'committee',
  'pipeline',
  'shadow',
])
export type RoutingMode = z.infer<typeof RoutingModeSchema>

export const StreamPolicySchema = z.enum(['primary-only', 'buffered-judge'])
export type StreamPolicy = z.infer<typeof StreamPolicySchema>

export const StageRoleSchema = z.enum([
  'advisor',
  'executor',
  'synthesizer',
  'judge',
  'shadow',
])
export type StageRole = z.infer<typeof StageRoleSchema>

export const InferenceExposureSchema = z.enum(['standard', 'admin-only'])
export type InferenceExposure = z.infer<typeof InferenceExposureSchema>

export const LifecycleStatusSchema = z.enum([
  'draft',
  'approved',
  'deprecated',
])
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>

export const RouteStageSchema = z.object({
  id: NonEmptyStringSchema,
  role: StageRoleSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  toolCallingMode: ToolCallingModeSchema.optional(),
  inputFrom: z.array(NonEmptyStringSchema).optional(),
  userVisible: z.boolean().optional(),
  maxAttempts: z.number().int().positive().optional(),
})
export type RouteStage = z.infer<typeof RouteStageSchema>

export const RoutingProfileSchema = z.object({
  id: InferenceRoutingProfileIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  exposure: InferenceExposureSchema,
  mode: RoutingModeSchema,
  streamPolicy: StreamPolicySchema,
  stages: z.array(RouteStageSchema),
})
export type RoutingProfile = z.infer<typeof RoutingProfileSchema>

export const CandidateOutputSchema = z.object({
  stageId: NonEmptyStringSchema,
  stageRole: StageRoleSchema,
  outputText: z.string(),
  structuredOutput: z.unknown().optional(),
  toolCalls: z.array(ToolCallIntentSchema).optional(),
  invocationIds: z.array(NonEmptyStringSchema),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type CandidateOutput = z.infer<typeof CandidateOutputSchema>

export const StageExecutionInputSchema = z.object({
  baseMessages: z.array(ProviderMessageSchema),
  upstream: z.array(CandidateOutputSchema),
})
export type StageExecutionInput = z.infer<typeof StageExecutionInputSchema>

export const StepMetadataStepSchema = z.enum([
  'primary',
  'fallback',
  'advisor',
  'synthesizer',
  'shadow',
  'judge',
  'tool-translation',
])
export type StepMetadataStep = z.infer<typeof StepMetadataStepSchema>

export const StepMetadataSchema = z.object({
  step: StepMetadataStepSchema,
  stageRole: StageRoleSchema,
  routingMode: RoutingModeSchema,
  stageId: NonEmptyStringSchema.optional(),
  retryOfInvocationId: NonEmptyStringSchema.optional(),
})
export type StepMetadata = z.infer<typeof StepMetadataSchema>

export const MultiProviderResultStatusSchema = z.enum(['completed', 'failed'])
export type MultiProviderResultStatus = z.infer<
  typeof MultiProviderResultStatusSchema
>

export const AnswerOwnerSchema = z.object({
  stageId: NonEmptyStringSchema,
  stageRole: StageRoleSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  invocationId: NonEmptyStringSchema,
})
export type AnswerOwner = z.infer<typeof AnswerOwnerSchema>

export const ToolExecutionOwnerSchema = z.object({
  stageId: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  invocationId: NonEmptyStringSchema,
})
export type ToolExecutionOwner = z.infer<typeof ToolExecutionOwnerSchema>

export const MultiProviderFailureSchema = z.object({
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  stageId: NonEmptyStringSchema.optional(),
})
export type MultiProviderFailure = z.infer<typeof MultiProviderFailureSchema>

export const MultiProviderResultSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  status: MultiProviderResultStatusSchema,
  finalAnswer: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  answerOwner: AnswerOwnerSchema.optional(),
  toolCalls: z.array(ProviderToolCallSchema),
  toolExecutionOwner: ToolExecutionOwnerSchema.nullable(),
  failure: MultiProviderFailureSchema.optional(),
  invocations: z.array(InvocationRecordSchema),
})
export type MultiProviderResult = z.infer<typeof MultiProviderResultSchema>

export const InferenceProviderConnectorKindSchema = z.enum([
  'compiled',
  'openai-compatible',
])
export type InferenceProviderConnectorKind = z.infer<
  typeof InferenceProviderConnectorKindSchema
>

export const InferenceProviderSchema = z.object({
  id: InferenceProviderIdSchema,
  organizationId: OrganizationIdSchema,
  providerKey: NonEmptyStringSchema,
  connectorKind: InferenceProviderConnectorKindSchema,
  displayName: NonEmptyStringSchema,
  enabled: z.boolean(),
  lifecycleStatus: LifecycleStatusSchema,
  baseUrl: z.string().url().optional(),
  supportsModelDiscovery: z.boolean(),
  activeCredentialBindingId: InferenceCredentialBindingIdSchema.optional(),
  healthStatus: ProviderHealthStatusSchema,
  lastCheckedAt: TimestampSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceProvider = z.infer<typeof InferenceProviderSchema>

export const InferenceCredentialBindingSchema = z.object({
  id: InferenceCredentialBindingIdSchema,
  organizationId: OrganizationIdSchema,
  providerId: InferenceProviderIdSchema,
  label: NonEmptyStringSchema,
  authSecretRef: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
})
export type InferenceCredentialBinding = z.infer<
  typeof InferenceCredentialBindingSchema
>

export const InferenceModelSchema = z.object({
  id: InferenceModelIdSchema,
  organizationId: OrganizationIdSchema,
  providerId: InferenceProviderIdSchema,
  model: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema.optional(),
  enabled: z.boolean(),
  lifecycleStatus: LifecycleStatusSchema,
  capabilitySnapshot: ModelCapabilitySnapshotSchema,
  source: ModelCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
  createdByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceModel = z.infer<typeof InferenceModelSchema>

export const InferenceRoutingProfileSchema = RoutingProfileSchema.extend({
  organizationId: OrganizationIdSchema,
  lifecycleStatus: LifecycleStatusSchema,
  createdByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceRoutingProfile = z.infer<
  typeof InferenceRoutingProfileSchema
>

export const ToolIntentTranslationRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  rawIntentBlock: z.string(),
  toolSchemas: z.array(ToolSchemaDescriptorSchema),
})
export type ToolIntentTranslationRequest = z.infer<
  typeof ToolIntentTranslationRequestSchema
>

export const StructuredOutputRepairRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  rawOutput: z.string(),
  targetSchema: StructuredOutputDescriptorSchema,
})
export type StructuredOutputRepairRequest = z.infer<
  typeof StructuredOutputRepairRequestSchema
>

export interface ProviderConnector {
  readonly provider: string
  getProviderMeta(): Promise<ProviderConnectorMeta>
  listModels(): Promise<ModelCapabilitySnapshot[]>
  getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot>
  checkHealth(): Promise<ProviderHealthReport>
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>
  stream?(
    request: ProviderInvocationRequest,
  ): AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined>
  close(): void
}

export interface ConnectorRegistry {
  getConfigured(config: ProviderConnectionConfig): Promise<ProviderConnector>
  listRegistered(): Promise<string[]>
}

export interface CapabilityCatalog {
  resolve(provider: string, model: string): Promise<CapabilityResolution>
}

export interface ToolMediator {
  translateToolIntent(
    input: ToolIntentTranslationRequest,
  ): Promise<ToolCallIntent>
  repairStructuredOutput(
    input: StructuredOutputRepairRequest,
  ): Promise<unknown>
}

export interface InferenceService {
  run(request: InferenceRequest): Promise<MultiProviderResult>
  stream?(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamEvent, MultiProviderResult, undefined>
}
