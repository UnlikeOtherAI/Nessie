import {
  ExecutorEnrollmentRequestSchema,
  ExecutorPrivateAssignmentSchema,
  ExecutorScopeSchema,
  ExecutorStatusSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const ExecutorRecordSchema = z.object({
  id: z.string().uuid(),
  scope: ExecutorScopeSchema,
  label: NonEmptyStringSchema,
  profiles: z.array(z.enum(['workspace_sandbox', 'coding_session'])),
  platformFacts: z.record(z.string(), z.unknown()),
  machineKeyFingerprint: z.string().optional(),
  status: ExecutorStatusSchema,
  authorizationRevision: z.number().int().positive(),
  lastSeenAt: TimestampSchema.optional(),
  statusDetail: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutorRecord = z.infer<typeof ExecutorRecordSchema>

export const CreateExecutorBodySchema = z.object({
  label: NonEmptyStringSchema.max(120),
  scope: ExecutorScopeSchema,
  privateAssignments: z.array(ExecutorPrivateAssignmentSchema).min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.scope.kind === 'private' && !value.privateAssignments) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Private executors require explicit user and agent assignments.',
      path: ['privateAssignments'],
    })
  }
  if (value.scope.kind !== 'private' && value.privateAssignments !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Private assignments are valid only for private executors.',
      path: ['privateAssignments'],
    })
  }
})
export type CreateExecutorBody = z.infer<typeof CreateExecutorBodySchema>

export const ExecutorPairingInvitationSchema = z.object({
  enrollmentId: z.string().uuid(),
  challenge: z.string().min(32),
  expiresAt: TimestampSchema,
})
export type ExecutorPairingInvitation = z.infer<typeof ExecutorPairingInvitationSchema>

export const CreateExecutorResponseSchema = z.object({
  executor: ExecutorRecordSchema,
  invitation: ExecutorPairingInvitationSchema,
})
export type CreateExecutorResponse = z.infer<typeof CreateExecutorResponseSchema>

export const PendingExecutorEnrollmentSchema = z.object({
  executorId: z.string().uuid(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  descriptorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: TimestampSchema,
})
export type PendingExecutorEnrollment = z.infer<typeof PendingExecutorEnrollmentSchema>

export const ConfirmExecutorEnrollmentBodySchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()
export type ConfirmExecutorEnrollmentBody = z.infer<
  typeof ConfirmExecutorEnrollmentBodySchema
>

export const SubmitExecutorEnrollmentBodySchema = ExecutorEnrollmentRequestSchema
export type SubmitExecutorEnrollmentBody = z.infer<typeof SubmitExecutorEnrollmentBodySchema>
