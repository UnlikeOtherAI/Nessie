import { z } from 'zod'

import {
  ProviderInvocationRequestSchema as SharedProviderInvocationRequestSchema,
  ProviderInvocationResultSchema as SharedProviderInvocationResultSchema,
  ProviderMessageSchema,
  ProviderToolCallSchema,
  ToolCallingModeSchema,
  ToolCallIntentSchema,
  ToolSchemaDescriptorSchema as SharedToolSchemaDescriptorSchema,
} from '@nessie/schemas'
import {
  InvocationRecordSchema,
  NormalizedFinishReasonSchema,
} from '@nessie/schemas'

import { NonEmptyStringSchema } from './shared.js'

// ─── Inference control plane ──────────────────────────────────────────────
//
// These contracts describe the same provider/inference wire shapes as
// `packages/schemas/src/inference-core.ts`. Where the api layer has no
// stricter requirement of its own the shared schema is re-exported directly;
// api-only tightening (a uuid invocation id, defaulted tool-call arrays, a
// non-empty tool description) is expressed as a composition over the shared
// pieces, never as a second hand-written copy. The conformance test
// `api/test/inference-core-contract-conformance.test.ts` asserts the api
// surface stays at least as strict as the shared one.

export const InferenceConnectorKindSchema = z.enum(['compiled', 'openai-compatible'])
export type InferenceConnectorKind = z.infer<typeof InferenceConnectorKindSchema>

export const InferenceLifecycleStatusSchema = z.enum(['draft', 'approved', 'deprecated'])
export type InferenceLifecycleStatus = z.infer<typeof InferenceLifecycleStatusSchema>

export const InferenceHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unreachable',
  'unknown',
])
export type InferenceHealthStatus = z.infer<typeof InferenceHealthStatusSchema>

export const InferenceCapabilitySourceSchema = z.enum(['static', 'live', 'manual'])
export type InferenceCapabilitySource = z.infer<typeof InferenceCapabilitySourceSchema>

export const InferenceExposureSchema = z.enum(['standard', 'admin-only'])
export type InferenceExposure = z.infer<typeof InferenceExposureSchema>

export const InferenceRoutingModeSchema = z.enum([
  'single',
  'fallback',
  'committee',
  'pipeline',
  'shadow',
])
export type InferenceRoutingMode = z.infer<typeof InferenceRoutingModeSchema>

export const InferenceStageRoleSchema = z.enum([
  'advisor',
  'executor',
  'synthesizer',
  'judge',
  'shadow',
])
export type InferenceStageRole = z.infer<typeof InferenceStageRoleSchema>

export const InferenceStreamPolicySchema = z.enum(['primary-only', 'buffered-judge'])
export type InferenceStreamPolicy = z.infer<typeof InferenceStreamPolicySchema>

export const InferenceEvalStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type InferenceEvalStatus = z.infer<typeof InferenceEvalStatusSchema>

export {
  NormalizedFinishReasonSchema,
  type NormalizedFinishReason,
  ProviderHealthStatusSchema,
  type ProviderHealthStatus,
  ProviderMessageContentPartSchema,
  type ProviderMessageContentPart,
  ProviderMessageSchema,
  type ProviderMessage,
  ProviderStreamEventSchema,
  type ProviderStreamEvent,
  ProviderToolCallSchema,
  type ProviderToolCall,
  StructuredOutputDescriptorSchema,
  type StructuredOutputDescriptor,
  StructuredOutputModeSchema,
  type StructuredOutputMode,
  SystemPromptModeSchema,
  type SystemPromptMode,
  ToolCallingModeSchema,
  type ToolCallingMode,
  ToolCallIntentSchema,
  type ToolCallIntent,
  ToolChoiceSchema,
  type ToolChoice,
  ToolResultModeSchema,
  type ToolResultMode,
  JsonObjectResponseFormatSchema,
  type JsonObjectResponseFormat,
  ModelCapabilityUsageReportingSchema,
  type ModelCapabilityUsageReporting,
  ModelCapabilitySnapshotSchema,
  type ModelCapabilitySnapshot,
  CapabilityResolutionSourceSchema,
  type CapabilityResolutionSource,
  CapabilityResolutionSchema,
  type CapabilityResolution,
  InvocationUsageSchema,
  type InvocationUsage,
  InvocationRecordSchema,
  type InvocationRecord,
} from '@nessie/schemas'

// The api surface requires a human-readable, non-empty tool description where
// the shared schema admits any string; everything else is the shared shape.
export const ToolSchemaDescriptorSchema = SharedToolSchemaDescriptorSchema.extend({
  description: NonEmptyStringSchema,
})
export type ToolSchemaDescriptor = z.infer<typeof ToolSchemaDescriptorSchema>

// The api invocation envelope adds a uuid invocation id and defaults the
// tool-call array for response parsing; both are compositions over the
// shared request/result envelopes, not parallel copies.
export const ProviderInvocationRequestSchema = SharedProviderInvocationRequestSchema.extend({
  tools: ToolSchemaDescriptorSchema.array().optional(),
})
export type ProviderInvocationRequest = z.infer<typeof ProviderInvocationRequestSchema>

export const ProviderInvocationResultSchema = SharedProviderInvocationResultSchema.extend({
  toolCalls: ProviderToolCallSchema.array().default([]),
  invocation: InvocationRecordSchema,
})
export type ProviderInvocationResult = z.infer<typeof ProviderInvocationResultSchema>

export const MultiProviderResultSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  status: z.enum(['completed', 'failed']),
  finalAnswer: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  answerOwner: z
    .object({
      stageId: NonEmptyStringSchema,
      stageRole: InferenceStageRoleSchema,
      provider: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
      invocationId: z.string().uuid(),
    })
    .optional(),
  toolCalls: ProviderToolCallSchema.array().default([]),
  toolExecutionOwner: z
    .object({
      stageId: NonEmptyStringSchema,
      provider: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
      invocationId: z.string().uuid(),
    })
    .nullable(),
  failure: z
    .object({
      code: z.string(),
      message: z.string(),
      stageId: z.string().min(1).optional(),
    })
    .optional(),
  invocations: InvocationRecordSchema.array(),
})
export type MultiProviderResult = z.infer<typeof MultiProviderResultSchema>

export const RouteStageSchema = z.object({
  id: NonEmptyStringSchema,
  role: InferenceStageRoleSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  toolCallingMode: ToolCallingModeSchema.optional(),
  inputFrom: z.array(NonEmptyStringSchema).optional(),
  userVisible: z.boolean().optional(),
  maxAttempts: z.number().int().positive().optional(),
})
export type RouteStage = z.infer<typeof RouteStageSchema>

export const RouteGraphSchema = z.object({
  stages: RouteStageSchema.array().min(1),
})
export type RouteGraph = z.infer<typeof RouteGraphSchema>

export const CandidateOutputSchema = z.object({
  stageId: NonEmptyStringSchema,
  stageRole: InferenceStageRoleSchema,
  outputText: z.string(),
  structuredOutput: z.unknown().optional(),
  toolCalls: ToolCallIntentSchema.array().optional(),
  invocationIds: z.array(z.string().uuid()),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type CandidateOutput = z.infer<typeof CandidateOutputSchema>

export const StageExecutionInputSchema = z.object({
  baseMessages: ProviderMessageSchema.array(),
  upstream: CandidateOutputSchema.array(),
})
export type StageExecutionInput = z.infer<typeof StageExecutionInputSchema>

export const EvalDatasetRefSchema = z.object({
  kind: z.enum(['file', 'dataset', 'query']),
  value: NonEmptyStringSchema,
})
export type DatasetRef = z.infer<typeof EvalDatasetRefSchema>

export const EvalSummarySchema = z.object({
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  score: z.number().nonnegative(),
  blockingFailures: z.array(z.string()),
})
export type EvalSummary = z.infer<typeof EvalSummarySchema>

export const EvalCaseVerdictSchema = z.enum(['pass', 'fail', 'blocked', 'skipped'])
export type EvalCaseVerdict = z.infer<typeof EvalCaseVerdictSchema>

export const EvalCaseResultSchema = z.object({
  caseId: NonEmptyStringSchema,
  input: z.unknown(),
  expected: z.unknown().optional(),
  actual: z.unknown(),
  verdict: EvalCaseVerdictSchema,
  invocationIds: z.array(z.string().uuid()),
  metadata: z.record(z.unknown()).optional(),
})
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>
