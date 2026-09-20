import {
  AgentAvailabilityProjectionSchema,
  LocalInferenceAttemptFrameSchema,
  LocalInferenceAttemptPollSchema,
  LocalInferenceAttemptResultReceiptSchema,
  LocalInferenceSignedEnvelopeSchema,
  LocalInferenceDaemonChallengeSchema,
  LocalInferenceDaemonConnectionSchema,
  LocalInferenceExecutorHostRequestSchema,
  LocalInferenceExecutorHostSchema,
  LocalInferenceHostListSchema,
  ObservedLocalModelSchema,
} from '@nessie/schemas'
import { z } from 'zod'

export { AgentAvailabilityProjectionSchema, LocalInferenceHostListSchema }
export { LocalInferenceDaemonChallengeSchema, LocalInferenceDaemonConnectionSchema }
export { LocalInferenceExecutorHostSchema }

export const LocalInferenceDaemonChallengeBodySchema = z.object({
  hostId: z.string().uuid(),
}).strict()

export const LocalInferenceDaemonClaimBodySchema = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  envelope: LocalInferenceSignedEnvelopeSchema,
}).strict()

export const LocalInferenceExecutorHostBodySchema = LocalInferenceExecutorHostRequestSchema

export const EnrollLocalInferenceHostBodySchema = z.object({
  displayLabel: z.string().trim().min(1).max(80),
  publicKey: z.string().trim().min(64).max(8_192),
}).strict()

export const PrepareLocalInferenceBindingBodySchema = z.object({
  hostId: z.string().uuid(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelName: z.string().trim().min(1).max(200),
}).strict()

/** The daemon only confirms an already-prepared exact binding. */
export const ConfirmLocalInferenceBindingBodySchema = z.object({
  challengeId: z.string().uuid(),
  signature: z.string().min(16).max(16_384),
}).strict()

export const LocalInferenceHeartbeatSchema = z.object({
  inventory: z.array(ObservedLocalModelSchema).max(100),
  paused: z.boolean(),
}).strict()

/** Signed by the machine key; the body digest covers `heartbeat`, not headers. */
export const LocalInferenceHeartbeatRequestSchema = z.object({
  envelope: LocalInferenceSignedEnvelopeSchema,
  heartbeat: LocalInferenceHeartbeatSchema,
}).strict()

export const LocalInferenceAttemptPollRequestSchema = z.object({
  envelope: LocalInferenceSignedEnvelopeSchema,
  poll: LocalInferenceAttemptPollSchema,
}).strict()

export const LocalInferenceAttemptFrameRequestSchema = z.object({
  envelope: LocalInferenceSignedEnvelopeSchema,
  frame: LocalInferenceAttemptFrameSchema,
}).strict()

export const LocalInferenceAttemptResultRequestSchema = z.object({
  envelope: LocalInferenceSignedEnvelopeSchema,
  receipt: LocalInferenceAttemptResultReceiptSchema,
}).strict()
