import {
  ExecutorAccessChangeRequestSchema,
  ExecutorAccessChangeResponseSchema,
  ExecutorCreateResponseSchema,
  ExecutorDaemonChallengeResponseSchema,
  ExecutorDaemonClaimRequestSchema,
  ExecutorDaemonCommandPollRequestSchema,
  ExecutorDaemonCommandPollResponseSchema,
  ExecutorDaemonCommandReceiptRequestSchema,
  ExecutorDaemonConnectionResponseSchema,
  ExecutorDaemonDescriptorRequestSchema,
  ExecutorDaemonDescriptorResponseSchema,
  ExecutorDaemonHeartbeatRequestSchema,
  ExecutorEnrollmentRequestSchema,
  ExecutorPrivateAssignmentSchema,
  ExecutorAccessViewResponseSchema,
  ExecutorAvailabilityRequestSchema,
  ExecutorAvailabilityResponseSchema as ExecutorAvailabilityResponseContractSchema,
  ExecutorPairingInvitationResponseSchema,
  ExecutorRecordResponseSchema,
  ExecutorRunBindRequestSchema,
  ExecutorRunBindResponseSchema,
  ExecutorRunLaunchRequestSchema,
  ExecutorRunLaunchResponseSchema,
  ExecutorScopeSchema,
  ExecutorWorkspaceReviewRecordResponseSchema,
  PendingExecutorEnrollmentResponseSchema,
  PreparedExecutorAccessChangeResponseSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema } from './shared.js'

export const ExecutorRecordSchema = ExecutorRecordResponseSchema
export type ExecutorRecord = z.infer<typeof ExecutorRecordSchema>

export const ExecutorAvailabilityRequestBodySchema = ExecutorAvailabilityRequestSchema
export type ExecutorAvailabilityRequestBody = z.infer<typeof ExecutorAvailabilityRequestBodySchema>

export const ExecutorAvailabilityResponseSchema = ExecutorAvailabilityResponseContractSchema
export type ExecutorAvailabilityResponse = z.infer<typeof ExecutorAvailabilityResponseSchema>

export const ExecutorRunBindBodySchema = ExecutorRunBindRequestSchema
export type ExecutorRunBindBody = z.infer<typeof ExecutorRunBindBodySchema>
export const ExecutorRunBindSchema = ExecutorRunBindResponseSchema

export const ExecutorRunLaunchBodySchema = ExecutorRunLaunchRequestSchema
export type ExecutorRunLaunchBody = z.infer<typeof ExecutorRunLaunchBodySchema>
export const ExecutorRunLaunchSchema = ExecutorRunLaunchResponseSchema

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

export const ExecutorDaemonDescriptorBodySchema = ExecutorDaemonDescriptorRequestSchema
export type ExecutorDaemonDescriptorBody = z.infer<typeof ExecutorDaemonDescriptorBodySchema>

export const ExecutorDaemonCommandPollBodySchema = ExecutorDaemonCommandPollRequestSchema
export type ExecutorDaemonCommandPollBody = z.infer<typeof ExecutorDaemonCommandPollBodySchema>

export const ExecutorDaemonCommandReceiptBodySchema = ExecutorDaemonCommandReceiptRequestSchema
export type ExecutorDaemonCommandReceiptBody = z.infer<typeof ExecutorDaemonCommandReceiptBodySchema>

export const ExecutorDaemonChallengeSchema = ExecutorDaemonChallengeResponseSchema
export const ExecutorDaemonConnectionSchema = ExecutorDaemonConnectionResponseSchema
export const ExecutorDaemonDescriptorSchema = ExecutorDaemonDescriptorResponseSchema
export const ExecutorDaemonCommandPollSchema = ExecutorDaemonCommandPollResponseSchema

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

export const ExecutorWorkspaceReviewRecordSchema = ExecutorWorkspaceReviewRecordResponseSchema
export type ExecutorWorkspaceReviewRecord = z.infer<typeof ExecutorWorkspaceReviewRecordSchema>
