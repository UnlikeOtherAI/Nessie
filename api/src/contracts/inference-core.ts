import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

// ─── Inference control plane ──────────────────────────────────────────────

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

export const NormalizedFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool-call',
  'content-filter',
  'error',
  'other',
])
export type NormalizedFinishReason = z.infer<typeof NormalizedFinishReasonSchema>

export const ToolCallingModeSchema = z.enum(['native', 'prompt-translated', 'disabled'])
export type ToolCallingMode = z.infer<typeof ToolCallingModeSchema>

export const StructuredOutputModeSchema = z.enum([
  'native-json',
  'prompt-json',
  'text-only',
])
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>

export const SystemPromptModeSchema = z.enum(['native', 'fold-into-user'])
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>

export const ToolResultModeSchema = z.enum(['native-tool-message', 'context-block'])
export type ToolResultMode = z.infer<typeof ToolResultModeSchema>

export const ProviderHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unreachable',
  'unknown',
])
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>

export const ProviderMessageContentPartSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    imageUrl: z.string().min(1),
  }),
])
export type ProviderMessageContentPart = z.infer<typeof ProviderMessageContentPartSchema>

const ProviderMessageContentSchema = z.union([
  z.string(),
  ProviderMessageContentPartSchema.array(),
])

export const ProviderToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>

export const ProviderMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('system'),
    content: ProviderMessageContentSchema,
  }),
  z.object({
    role: z.literal('user'),
    content: ProviderMessageContentSchema,
  }),
  z.object({
    role: z.literal('assistant'),
    content: ProviderMessageContentSchema.nullable(),
    toolCalls: ProviderToolCallSchema.array().optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: z.string().min(1),
  }),
])
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>

export const ToolSchemaDescriptorSchema = z.object({
  toolName: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  inputSchema: z.record(z.unknown()),
})
export type ToolSchemaDescriptor = z.infer<typeof ToolSchemaDescriptorSchema>

export const ToolCallIntentSchema = z.object({
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ToolCallIntent = z.infer<typeof ToolCallIntentSchema>

export const StructuredOutputDescriptorSchema = z.object({
  name: NonEmptyStringSchema,
  jsonSchema: z.record(z.unknown()),
})
export type StructuredOutputDescriptor = z.infer<typeof StructuredOutputDescriptorSchema>

export const JsonObjectResponseFormatSchema = z.object({
  type: z.literal('json_object'),
})
export type JsonObjectResponseFormat = z.infer<
  typeof JsonObjectResponseFormatSchema
>

export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: NonEmptyStringSchema,
    }),
  }),
])
export type ToolChoice = z.infer<typeof ToolChoiceSchema>

export const ModelCapabilityUsageReportingSchema = z.object({
  inputTokens: z.boolean(),
  outputTokens: z.boolean(),
  cachedInputTokens: z.boolean(),
  cachedOutputTokens: z.boolean(),
  cacheReadTokens: z.boolean(),
  cacheWriteTokens: z.boolean(),
  providerReportedCost: z.boolean(),
})
export type ModelCapabilityUsageReporting = z.infer<
  typeof ModelCapabilityUsageReportingSchema
>

export const ModelCapabilitySnapshotSchema = z.object({
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  displayName: z.string().optional(),
  supportsModelDiscovery: z.boolean(),
  supportsChat: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsEmbeddings: z.boolean(),
  supportsVision: z.boolean(),
  toolCallingMode: ToolCallingModeSchema,
  structuredOutputMode: StructuredOutputModeSchema,
  systemPromptMode: SystemPromptModeSchema,
  toolResultMode: ToolResultModeSchema,
  usageReporting: ModelCapabilityUsageReportingSchema,
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  source: InferenceCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
})
export type ModelCapabilitySnapshot = z.infer<typeof ModelCapabilitySnapshotSchema>

export const CapabilityResolutionSourceSchema = z.enum([
  'override',
  'static',
  'live',
  'manual',
])
export type CapabilityResolutionSource = z.infer<typeof CapabilityResolutionSourceSchema>

export const CapabilityResolutionSchema = z.object({
  effectiveSnapshot: ModelCapabilitySnapshotSchema,
  effectiveSource: CapabilityResolutionSourceSchema,
  overrideActive: z.boolean(),
})
export type CapabilityResolution = z.infer<typeof CapabilityResolutionSchema>

export const InvocationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cachedOutputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})
export type InvocationUsage = z.infer<typeof InvocationUsageSchema>

export const InvocationRecordSchema = z.object({
  invocationId: z.string().uuid(),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: z.enum([
    'chat',
    'completion',
    'embedding',
    'translation',
    'reasoning',
    'tool-translation',
    'other',
  ]),
  usage: InvocationUsageSchema,
  providerReportedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  latencyMs: z.number().int().nonnegative(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type InvocationRecord = z.infer<typeof InvocationRecordSchema>

export const ProviderInvocationRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema,
  messages: ProviderMessageSchema.array(),
  tools: ToolSchemaDescriptorSchema.array().optional(),
  toolChoice: ToolChoiceSchema.optional(),
  responseFormat: JsonObjectResponseFormatSchema.optional(),
  expectedStructuredOutput: StructuredOutputDescriptorSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type ProviderInvocationRequest = z.infer<typeof ProviderInvocationRequestSchema>

export const ProviderInvocationResultSchema = z.object({
  outputText: z.string(),
  toolCalls: ProviderToolCallSchema.array().default([]),
  structuredOutput: z.unknown().optional(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  invocation: InvocationRecordSchema,
})
export type ProviderInvocationResult = z.infer<typeof ProviderInvocationResultSchema>

export const ProviderStreamEventSchema = z.union([
  z.object({
    type: z.literal('output_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('response.error'),
    message: z.string(),
    retryable: z.boolean(),
  }),
])
export type ProviderStreamEvent = z.infer<typeof ProviderStreamEventSchema>

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
