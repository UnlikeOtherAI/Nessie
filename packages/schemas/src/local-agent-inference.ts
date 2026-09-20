import { z } from 'zod'

import { PaginationMetaSchema } from './api.js'
import {
  ModelCapabilitySnapshotSchema,
  ProviderMessageSchema,
  ProviderToolCallSchema,
  ToolSchemaDescriptorSchema,
} from './inference-core.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * Contracts for the owner-host-only local Ollama lane.  This is deliberately
 * separate from `local-inference.ts`: that module is a curated download
 * catalogue, whereas these values are observations made by a person's host.
 */
export const LocalInferenceTransportSchema = z.enum(['executor', 'desktop'])
export type LocalInferenceTransport = z.infer<typeof LocalInferenceTransportSchema>

/** The single version both the executor and Desktop-host bridge speak. */
export const LOCAL_INFERENCE_PROTOCOL_VERSION = 1

const LocalInferenceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const LocalInferenceMachineSignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(64)
  .max(128)

/**
 * Each host message has an independent sequence lane.  A poll may wait without
 * delaying a cancellation or liveness update, but cannot be replayed as one.
 */
export const LocalInferenceEnvelopePurposeSchema = z.enum([
  'claim',
  'heartbeat',
  'poll',
  'frames',
  'result',
  'goodbye',
])
export type LocalInferenceEnvelopePurpose = z.infer<typeof LocalInferenceEnvelopePurposeSchema>

/**
 * The body travels beside this header, but only its canonical digest is signed.
 * Routes still parse their own purpose-specific bounded body before acting.
 */
export const LocalInferenceEnvelopeCoreSchema = z.object({
  bodyDigest: LocalInferenceDigestSchema,
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  hostId: z.string().uuid(),
  organizationId: z.string().uuid(),
  protocolVersion: z.literal(LOCAL_INFERENCE_PROTOCOL_VERSION),
  purpose: LocalInferenceEnvelopePurposeSchema,
  sentAt: z.string().datetime({ offset: true }).max(40),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type LocalInferenceEnvelopeCore = z.infer<typeof LocalInferenceEnvelopeCoreSchema>
export type LocalInferenceEnvelopeCoreInput = z.input<typeof LocalInferenceEnvelopeCoreSchema>

export const LocalInferenceSignedEnvelopeSchema = LocalInferenceEnvelopeCoreSchema.extend({
  signature: LocalInferenceMachineSignatureSchema,
}).strict()
export type LocalInferenceSignedEnvelope = z.infer<typeof LocalInferenceSignedEnvelopeSchema>

export const LocalInferenceBindingStatusSchema = z.enum([
  'pending',
  'consented_pending_activation',
  'active',
  'needs_rebinding',
  'revoked',
])
export type LocalInferenceBindingStatus = z.infer<typeof LocalInferenceBindingStatusSchema>

export const AgentAvailabilitySchema = z.enum(['online', 'offline', 'unknown'])
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>

export const LocalInferenceAvailabilityReasonSchema = z.enum([
  'unconfigured',
  'pending_consent',
  'connecting',
  'offline',
  'paused',
  'model_missing',
  'model_changed',
  'incompatible',
  'policy_denied',
  'needs_reauthorization',
  'entitlement_unavailable',
  'revoked',
  'ready',
  'busy',
])
export type LocalInferenceAvailabilityReason = z.infer<
  typeof LocalInferenceAvailabilityReasonSchema
>

const LocalSocketSchema = z.union([
  z.literal('http://127.0.0.1:11434'),
  z.literal('http://[::1]:11434'),
  z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/),
])

export const ObservedLocalModelSchema = z.object({
  capabilities: z.array(z.enum(['text', 'tools', 'json_schema'])).max(16),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  name: NonEmptyStringSchema.max(200),
  numCtxCap: z.number().int().positive().max(1_000_000).nullable(),
  remoteHost: z.string().max(512).nullable(),
  remoteModel: z.string().max(512).nullable(),
  reportedAt: TimestampSchema,
  sizeBytes: z.number().int().nonnegative().nullable(),
})
export type ObservedLocalModel = z.infer<typeof ObservedLocalModelSchema>

export const LocalInferenceHostSchema = z.object({
  availability: AgentAvailabilitySchema,
  canonicalSocket: LocalSocketSchema.nullable(),
  id: z.string().uuid(),
  lastSeenAt: TimestampSchema.nullable(),
  models: z.array(ObservedLocalModelSchema).max(100),
  status: LocalInferenceBindingStatusSchema.or(z.literal('unconfigured')),
  transport: LocalInferenceTransportSchema,
})
export type LocalInferenceHost = z.infer<typeof LocalInferenceHostSchema>

export const LocalInferenceHostListSchema = z.object({
  hosts: z.array(LocalInferenceHostSchema),
  meta: PaginationMetaSchema,
})

export const LocalInferenceMessageSchema = ProviderMessageSchema

export const LocalInferenceAttemptRequestSchema = z.object({
  attemptId: z.string().uuid(),
  bindingId: z.string().uuid(),
  bindingRevision: z.number().int().positive(),
  deadlineAt: TimestampSchema,
  hostEpoch: z.number().int().positive(),
  hostId: z.string().uuid(),
  invocationId: NonEmptyStringSchema.max(160),
  maxOutputTokens: z.number().int().positive().max(100_000),
  messages: z.array(LocalInferenceMessageSchema).max(1_000),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelName: NonEmptyStringSchema.max(200),
  numCtx: z.number().int().positive().max(8_192),
  protocolVersion: z.literal(1),
  runId: z.string().uuid(),
  runFence: NonEmptyStringSchema.max(160),
  tools: z.array(ToolSchemaDescriptorSchema).max(128),
})
export type LocalInferenceAttemptRequest = z.infer<typeof LocalInferenceAttemptRequestSchema>

export const LocalInferenceResultSchema = z.object({
  capability: ModelCapabilitySnapshotSchema,
  content: z.string().max(512 * 1024).nullable(),
  finishReason: z.enum(['stop', 'length', 'tool-call', 'error', 'other']),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  remoteHost: z.string().max(512).nullable(),
  remoteModel: z.string().max(512).nullable(),
  toolCalls: z.array(ProviderToolCallSchema).max(128),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  }),
})
export type LocalInferenceResult = z.infer<typeof LocalInferenceResultSchema>

/** A host receives only one leased attempt at a time; an empty poll body is
 * still signed so a captured request cannot be replayed under another route. */
export const LocalInferenceAttemptPollSchema = z.object({}).strict()

/** An opaque, one-use challenge is the only input to a connection claim. */
export const LocalInferenceDaemonChallengeSchema = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  expiresAt: TimestampSchema,
})

export const LocalInferenceDaemonConnectionSchema = z.object({
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  serverTime: TimestampSchema,
})

export const LocalInferenceAttemptFrameSchema = z.object({
  attemptId: z.string().uuid(),
  data: z.string().max(21_848), // base64url encoding of a 16 KiB frame
  dispatchFence: z.number().int().positive(),
  sequence: z.number().int().positive(),
}).strict()
export type LocalInferenceAttemptFrame = z.infer<typeof LocalInferenceAttemptFrameSchema>

export const LocalInferenceAttemptResultReceiptSchema = z.object({
  attemptId: z.string().uuid(),
  dispatchFence: z.number().int().positive(),
  result: LocalInferenceResultSchema,
}).strict()
export type LocalInferenceAttemptResultReceipt = z.infer<
  typeof LocalInferenceAttemptResultReceiptSchema
>

/** JSON limits are enforced before the encrypted payload is persisted. */
export const LOCAL_INFERENCE_MAX_REQUEST_BYTES = 2 * 1024 * 1024
export const LOCAL_INFERENCE_MAX_RESULT_BYTES = 512 * 1024
export const LOCAL_INFERENCE_MAX_FRAME_BYTES = 16 * 1024
export const LOCAL_INFERENCE_MAX_UNACKNOWLEDGED_FRAME_BYTES = 128 * 1024

export const assertLocalInferenceSerializedSize = (
  value: unknown,
  maximum: number,
): void => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) {
    throw new Error('Local inference protocol payload exceeds its bounded limit.')
  }
}

export const AgentAvailabilityProjectionSchema = z.object({
  availability: AgentAvailabilitySchema,
  reason: LocalInferenceAvailabilityReasonSchema,
  revision: z.number().int().nonnegative(),
  serverTime: TimestampSchema,
  validUntil: TimestampSchema,
})
export type AgentAvailabilityProjection = z.infer<typeof AgentAvailabilityProjectionSchema>
