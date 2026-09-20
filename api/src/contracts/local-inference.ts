import {
  AgentAvailabilityProjectionSchema,
  LocalInferenceHostListSchema,
  ObservedLocalModelSchema,
} from '@nessie/schemas'
import { z } from 'zod'

export { AgentAvailabilityProjectionSchema, LocalInferenceHostListSchema }

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

export const LocalInferenceHeartbeatBodySchema = z.object({
  connectionEpoch: z.number().int().positive(),
  inventory: z.array(ObservedLocalModelSchema).max(100),
  paused: z.boolean(),
}).strict()
