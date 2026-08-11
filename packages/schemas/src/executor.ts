import { z } from 'zod'

import {
  AgentIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  UserIdSchema,
} from './ids.js'
import { createUuidBrandSchema, TimestampSchema } from './schema-primitives.js'

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)
const NonEmptyRecordSchema = z.record(z.string(), z.unknown())

export const ExecutorIdSchema = createUuidBrandSchema<'ExecutorId'>()
export type ExecutorId = z.infer<typeof ExecutorIdSchema>

export const ExecutorEnrollmentIdSchema =
  createUuidBrandSchema<'ExecutorEnrollmentId'>()
export type ExecutorEnrollmentId = z.infer<typeof ExecutorEnrollmentIdSchema>

export const ExecutorBindingIdSchema = createUuidBrandSchema<'ExecutorBindingId'>()
export type ExecutorBindingId = z.infer<typeof ExecutorBindingIdSchema>

export const ExecutorSessionIdSchema = createUuidBrandSchema<'ExecutorSessionId'>()
export type ExecutorSessionId = z.infer<typeof ExecutorSessionIdSchema>

export const ExecutorCommandIdSchema = createUuidBrandSchema<'ExecutorCommandId'>()
export type ExecutorCommandId = z.infer<typeof ExecutorCommandIdSchema>

export const ExecutorAccessChangeIdSchema =
  createUuidBrandSchema<'ExecutorAccessChangeId'>()
export type ExecutorAccessChangeId = z.infer<typeof ExecutorAccessChangeIdSchema>

export const ExecutorScopeKindSchema = z.enum([
  'private',
  'project',
  'organization',
])
export type ExecutorScopeKind = z.infer<typeof ExecutorScopeKindSchema>

export const ExecutorScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('private'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('project'),
      organizationId: OrganizationIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('organization'),
      organizationId: OrganizationIdSchema,
    })
    .strict(),
])
export type ExecutorScope = z.infer<typeof ExecutorScopeSchema>

export const ExecutorStatusSchema = z.enum([
  'pending_pairing',
  'online',
  'offline',
  'paused',
  'draining',
  'revoked',
  'error',
])
export type ExecutorStatus = z.infer<typeof ExecutorStatusSchema>

export const ExecutorProfileSchema = z.enum(['workspace_sandbox', 'coding_session'])
export type ExecutorProfile = z.infer<typeof ExecutorProfileSchema>

export const ExecutorOperationKeySchema = z.enum([
  'file.list',
  'file.read',
  'file.write',
  'command.run',
  'browser.open',
  'browser.observe',
  'browser.act',
  'workspace.promote',
  'sandbox.stop',
  'coding.launch',
  'coding.attach',
  'coding.observe',
  'coding.prompt',
  'coding.interrupt',
  'coding.close',
])
export type ExecutorOperationKey = z.infer<typeof ExecutorOperationKeySchema>

export const ExecutorPrivateAssignmentSchema = z.discriminatedUnion(
  'principalKind',
  [
    z
      .object({
        principalKind: z.literal('user'),
        userId: UserIdSchema,
        role: z.enum(['use', 'admin']),
      })
      .strict(),
    z
      .object({
        principalKind: z.literal('agent'),
        agentId: AgentIdSchema,
        role: z.literal('use'),
      })
      .strict(),
  ],
)
export type ExecutorPrivateAssignment = z.infer<
  typeof ExecutorPrivateAssignmentSchema
>

export const ExecutorAgentOperationGrantStateSchema = z.enum(['allowed', 'denied'])
export type ExecutorAgentOperationGrantState = z.infer<
  typeof ExecutorAgentOperationGrantStateSchema
>

export const ExecutorAgentOperationGrantSchema = z
  .object({
    executorId: ExecutorIdSchema,
    agentId: AgentIdSchema,
    operationKey: ExecutorOperationKeySchema,
    state: ExecutorAgentOperationGrantStateSchema,
    authorizationRevision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict()
export type ExecutorAgentOperationGrant = z.infer<
  typeof ExecutorAgentOperationGrantSchema
>

export const ExecutorCapabilityDescriptorSchema = z
  .object({
    protocolVersion: z.literal(1),
    revision: z.number().int().positive(),
    profiles: z.array(ExecutorProfileSchema).min(1).max(2),
    platform: z
      .object({
        architecture: z.literal('arm64'),
        os: z.literal('macos'),
        osMajorVersion: z.number().int().min(15),
      })
      .strict(),
    operationKeys: z.array(ExecutorOperationKeySchema).min(1).max(16),
    localPolicyDigest: Sha256DigestSchema,
    limits: z
      .object({
        maxCommandRuntimeSeconds: z.number().int().positive(),
        maxResultBytes: z.number().int().positive(),
        maxSessions: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
export type ExecutorCapabilityDescriptor = z.infer<
  typeof ExecutorCapabilityDescriptorSchema
>

export const ExecutorSignedDescriptorSchema = z
  .object({
    descriptor: ExecutorCapabilityDescriptorSchema,
    signature: Base64UrlSchema,
  })
  .strict()
export type ExecutorSignedDescriptor = z.infer<
  typeof ExecutorSignedDescriptorSchema
>

export const ExecutorEnrollmentRequestSchema = z
  .object({
    enrollmentId: ExecutorEnrollmentIdSchema,
    challenge: Base64UrlSchema.min(32),
    machinePublicKey: Base64UrlSchema.min(32),
    descriptor: ExecutorSignedDescriptorSchema,
    proof: Base64UrlSchema.min(32),
  })
  .strict()
export type ExecutorEnrollmentRequest = z.infer<
  typeof ExecutorEnrollmentRequestSchema
>

export const ExecutorAvailabilityReasonSchema = z.enum([
  'ready',
  'executor_not_discoverable',
  'executor_offline',
  'scope_mismatch',
  'operation_ungranted',
  'logical_tool_ungranted',
  'descriptor_unreviewed',
  'local_policy_denied',
  'credential_unavailable',
])
export type ExecutorAvailabilityReason = z.infer<
  typeof ExecutorAvailabilityReasonSchema
>

export const ExecutorCandidateHandleSchema = z
  .string()
  .min(32)
  .max(512)
  .brand<'ExecutorCandidateHandle'>()
export type ExecutorCandidateHandle = z.infer<typeof ExecutorCandidateHandleSchema>

export const ExecutorAvailabilityRequestSchema = z
  .object({
    agentId: AgentIdSchema,
    operationKeys: z.array(ExecutorOperationKeySchema).min(1).max(16),
    projectId: ProjectIdSchema.optional(),
    runId: RunIdSchema.optional(),
  })
  .strict()
export type ExecutorAvailabilityRequest = z.infer<
  typeof ExecutorAvailabilityRequestSchema
>

export const ExecutorAvailabilityCandidateSchema = z
  .object({
    handle: ExecutorCandidateHandleSchema,
    operationKeys: z.array(ExecutorOperationKeySchema).min(1).max(16),
    readiness: z.literal('ready'),
    scopeKind: ExecutorScopeKindSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
export type ExecutorAvailabilityCandidate = z.infer<
  typeof ExecutorAvailabilityCandidateSchema
>

export const ExecutorAvailabilityExplanationSchema = z
  .object({
    readiness: z.literal('unavailable'),
    reason: ExecutorAvailabilityReasonSchema.exclude(['ready']),
  })
  .strict()
export type ExecutorAvailabilityExplanation = z.infer<
  typeof ExecutorAvailabilityExplanationSchema
>

export const ExecutorCommandReceiptStateSchema = z.enum([
  'accepted',
  'started',
  'result_acknowledged',
  'unknown_outcome',
])
export type ExecutorCommandReceiptState = z.infer<
  typeof ExecutorCommandReceiptStateSchema
>

export const ExecutorCommandEnvelopeSchema = z
  .object({
    commandId: ExecutorCommandIdSchema,
    bindingId: ExecutorBindingIdSchema,
    bindingFence: z.number().int().positive(),
    capabilityRevision: z.number().int().positive(),
    operationKey: ExecutorOperationKeySchema,
    expiresAt: TimestampSchema,
    idempotencyKey: z.string().min(1).max(255),
    argumentDigest: Sha256DigestSchema,
    payload: NonEmptyRecordSchema,
  })
  .strict()
export type ExecutorCommandEnvelope = z.infer<typeof ExecutorCommandEnvelopeSchema>

export const ExecutorCommandReceiptSchema = z
  .object({
    commandId: ExecutorCommandIdSchema,
    state: ExecutorCommandReceiptStateSchema,
    resultDigest: Sha256DigestSchema.optional(),
    occurredAt: TimestampSchema,
  })
  .strict()
export type ExecutorCommandReceipt = z.infer<typeof ExecutorCommandReceiptSchema>

export const ExecutorAccessChangeKindSchema = z.enum([
  'private_assignment',
  'agent_operation_grant',
])
export type ExecutorAccessChangeKind = z.infer<typeof ExecutorAccessChangeKindSchema>

export const ExecutorAccessChangePrepareSchema = z
  .object({
    executorId: ExecutorIdSchema,
    kind: ExecutorAccessChangeKindSchema,
    change: NonEmptyRecordSchema,
  })
  .strict()
export type ExecutorAccessChangePrepare = z.infer<
  typeof ExecutorAccessChangePrepareSchema
>

export const ExecutorAccessChangeConfirmationSchema = z
  .object({
    accessChangeId: ExecutorAccessChangeIdSchema,
    confirmationToken: Base64UrlSchema.min(32),
    verificationChallengeId: z.string().uuid().optional(),
  })
  .strict()
export type ExecutorAccessChangeConfirmation = z.infer<
  typeof ExecutorAccessChangeConfirmationSchema
>
