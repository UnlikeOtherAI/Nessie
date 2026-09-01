import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema } from './schema-primitives.js'

export const VerificationFactorTypeSchema = z.enum([
  'email_otp',
  'email_link',
  'totp',
  'recovery_code',
  'webauthn',
])
export type VerificationFactorType = z.infer<typeof VerificationFactorTypeSchema>

export const AccessActorSchema = z.object({
  actorType: z.enum(['user', 'agent', 'service']),
  actorId: NonEmptyStringSchema,
  roles: z.array(NonEmptyStringSchema).optional(),
})
export type AccessActor = z.infer<typeof AccessActorSchema>

export const TenantContextSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
})
export type TenantContext = z.infer<typeof TenantContextSchema>

export const UoaSessionIdentitySchema = z.object({
  subject: NonEmptyStringSchema,
  organizationId: NonEmptyStringSchema,
  teamId: NonEmptyStringSchema,
  tokenVersion: z.number().int().nonnegative().nullable(),
})
export type UoaSessionIdentity = z.infer<typeof UoaSessionIdentitySchema>

export const ActionContextSchema = z.object({
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  effectiveUserId: UserIdSchema.optional(),
  toolId: NonEmptyStringSchema.optional(),
  taskId: TaskIdSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  pushRegistrationVersion: NonEmptyStringSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  purpose: z.string().optional(),
  uoaIdentity: UoaSessionIdentitySchema.optional(),
})
export type ActionContext = z.infer<typeof ActionContextSchema>

export const AccessContextSchema = z.object({
  actor: AccessActorSchema,
  tenant: TenantContextSchema,
  actionContext: ActionContextSchema,
})
export type AccessContext = z.infer<typeof AccessContextSchema>

export const AuthorizedActionContextSchema = AccessContextSchema.extend({
  approval: z
    .object({
      approverId: NonEmptyStringSchema.optional(),
      approvalId: NonEmptyStringSchema.optional(),
      approvalProof: NonEmptyStringSchema.optional(),
      approvalContext: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  verification: z
    .object({
      challengeId: NonEmptyStringSchema,
      proof: NonEmptyStringSchema,
      factorType: VerificationFactorTypeSchema.optional(),
    })
    .optional(),
})
export type AuthorizedActionContext = z.infer<typeof AuthorizedActionContextSchema>

export const withActionContext = (
  actorContext: AuthorizedActionContext,
  fields: Partial<AuthorizedActionContext['actionContext']>,
): AuthorizedActionContext => ({
  ...actorContext,
  actionContext: { ...actorContext.actionContext, ...fields },
})
