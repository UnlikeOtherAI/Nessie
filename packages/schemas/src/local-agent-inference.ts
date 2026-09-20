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

export const AgentAvailabilityProjectionSchema = z.object({
  availability: AgentAvailabilitySchema,
  reason: LocalInferenceAvailabilityReasonSchema,
  revision: z.number().int().nonnegative(),
  serverTime: TimestampSchema,
  validUntil: TimestampSchema,
})
export type AgentAvailabilityProjection = z.infer<typeof AgentAvailabilityProjectionSchema>
