import {
  AgentIdSchema,
  AgentStatusSchema,
  AuthProviderResponseTypeSchema,
  ChannelIdSchema,
  MessageRoleSchema,
  OrganizationIdSchema,
  RunIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

const TimestampSchema = z.string().min(1)
const NonEmptyStringSchema = z.string().min(1)

export const AuthProviderDescriptorSchema = z.object({
  providerId: NonEmptyStringSchema,
  type: AuthProviderResponseTypeSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  autoRedirect: z.boolean(),
})
export type AuthProviderDescriptor = z.infer<typeof AuthProviderDescriptorSchema>

export const AuthProviderAuthorizeQuerySchema = z.object({
  codeChallenge: NonEmptyStringSchema,
  redirectUri: z.string().url(),
  state: NonEmptyStringSchema,
})
export type AuthProviderAuthorizeQuery = z.infer<typeof AuthProviderAuthorizeQuerySchema>

export const BootstrapModeResponseSchema = z.object({
  bootstrapMode: z.literal(true),
  bootstrapUrl: z.literal('/admin/bootstrap'),
})

export const BootstrapRequestSchema = z.object({
  bootstrapToken: z.string().uuid(),
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  password: z.string().min(8),
})

export const LoginRequestSchema = z.object({
  code: z.string().min(1).optional(),
  codeVerifier: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),
  providerId: NonEmptyStringSchema.optional(),
  redirectUri: z.string().url().optional(),
})

export const ChannelRecordSchema = z.object({
  id: ChannelIdSchema,
  label: NonEmptyStringSchema,
  visibility: z.enum(['public', 'protected', 'private']),
  organizationId: OrganizationIdSchema,
  teamId: TeamIdSchema,
  defaultThreadId: ThreadIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>

export const CreateChannelBodySchema = z.object({
  label: NonEmptyStringSchema,
  visibility: z.enum(['public', 'protected', 'private']).optional(),
})

export const AgentRecordSchema = z.object({
  id: AgentIdSchema,
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  status: AgentStatusSchema,
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
  lastActivityAt: TimestampSchema,
  systemPrompt: z.string().optional(),
  parentAgentId: AgentIdSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  channelIds: z.array(ChannelIdSchema),
})
export type AgentRecord = z.infer<typeof AgentRecordSchema>

export const CreateAgentBodySchema = z.object({
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
})

export const CreateAgentBindingBodySchema = z.object({
  channelId: ChannelIdSchema,
})

export const ThreadMessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: TimestampSchema,
})
export type ThreadMessageRecord = z.infer<typeof ThreadMessageRecordSchema>

export const CreateThreadMessageBodySchema = z.object({
  agentId: AgentIdSchema.optional(),
  content: NonEmptyStringSchema,
})

export const ToolDescriptorSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>

export const UserRecordSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  channelIds: z.array(ChannelIdSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserRecord = z.infer<typeof UserRecordSchema>

export const CreateUserBodySchema = z.object({
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  password: z.string().min(8),
  role: NonEmptyStringSchema.optional(),
  channelIds: z.array(ChannelIdSchema).optional(),
})
