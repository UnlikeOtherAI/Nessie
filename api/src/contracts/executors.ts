import {
  ExecutorAccessChangeRequestSchema,
  ExecutorAccessChangeResponseSchema,
  ExecutorCreateResponseSchema,
  ExecutorDaemonChallengeResponseSchema,
  ExecutorDaemonClaimRequestSchema,
  ExecutorDaemonConnectionResponseSchema,
  ExecutorDaemonHeartbeatRequestSchema,
  ExecutorEnrollmentRequestSchema,
  ExecutorPrivateAssignmentSchema,
  ExecutorAccessViewResponseSchema,
  ExecutorPairingInvitationResponseSchema,
  ExecutorRecordResponseSchema,
  ExecutorScopeSchema,
  PendingExecutorEnrollmentResponseSchema,
  PreparedExecutorAccessChangeResponseSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema } from './shared.js'

export const ExecutorRecordSchema = ExecutorRecordResponseSchema
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

export const ExecutorPairingInvitationSchema = ExecutorPairingInvitationResponseSchema
export type ExecutorPairingInvitation = z.infer<typeof ExecutorPairingInvitationSchema>

export const CreateExecutorResponseSchema = ExecutorCreateResponseSchema
export type CreateExecutorResponse = z.infer<typeof CreateExecutorResponseSchema>

export const PendingExecutorEnrollmentSchema = PendingExecutorEnrollmentResponseSchema
export type PendingExecutorEnrollment = z.infer<typeof PendingExecutorEnrollmentSchema>

export const ConfirmExecutorEnrollmentBodySchema = z.object({
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()
export type ConfirmExecutorEnrollmentBody = z.infer<
  typeof ConfirmExecutorEnrollmentBodySchema
>

export const SubmitExecutorEnrollmentBodySchema = ExecutorEnrollmentRequestSchema
export type SubmitExecutorEnrollmentBody = z.infer<typeof SubmitExecutorEnrollmentBodySchema>

export const ExecutorDaemonChallengeBodySchema = z.object({
  executorId: z.string().uuid(),
}).strict()
export type ExecutorDaemonChallengeBody = z.infer<typeof ExecutorDaemonChallengeBodySchema>

export const ExecutorDaemonClaimBodySchema = ExecutorDaemonClaimRequestSchema
export type ExecutorDaemonClaimBody = z.infer<typeof ExecutorDaemonClaimBodySchema>

export const ExecutorDaemonHeartbeatBodySchema = ExecutorDaemonHeartbeatRequestSchema
export type ExecutorDaemonHeartbeatBody = z.infer<typeof ExecutorDaemonHeartbeatBodySchema>

export const ExecutorDaemonChallengeSchema = ExecutorDaemonChallengeResponseSchema
export const ExecutorDaemonConnectionSchema = ExecutorDaemonConnectionResponseSchema

export const ExecutorAccessChangeSchema = ExecutorAccessChangeRequestSchema
export type ExecutorAccessChange = z.infer<typeof ExecutorAccessChangeSchema>

export const PrepareExecutorAccessChangeBodySchema = z.object({
  executorId: z.string().uuid(),
  change: ExecutorAccessChangeSchema,
}).strict()
export type PrepareExecutorAccessChangeBody = z.infer<
  typeof PrepareExecutorAccessChangeBodySchema
>

export const ConfirmExecutorAccessChangeBodySchema = z.object({
  confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  currentPassword: z.string().min(1).max(1024).optional(),
}).strict()
export type ConfirmExecutorAccessChangeBody = z.infer<
  typeof ConfirmExecutorAccessChangeBodySchema
>

export const ExecutorAccessChangeRecordSchema = ExecutorAccessChangeResponseSchema
export type ExecutorAccessChangeRecord = z.infer<typeof ExecutorAccessChangeRecordSchema>

export const PreparedExecutorAccessChangeSchema = PreparedExecutorAccessChangeResponseSchema
export type PreparedExecutorAccessChange = z.infer<
  typeof PreparedExecutorAccessChangeSchema
>

export const ExecutorAccessViewSchema = ExecutorAccessViewResponseSchema
export type ExecutorAccessView = z.infer<typeof ExecutorAccessViewSchema>

export const ReviewExecutorDescriptorBodySchema = z.object({
  revision: z.number().int().positive(),
  status: z.enum(['active', 'disabled']),
}).strict()
export type ReviewExecutorDescriptorBody = z.infer<typeof ReviewExecutorDescriptorBodySchema>
