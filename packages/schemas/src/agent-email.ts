import { z } from 'zod'

/**
 * Queue topics and API contracts for hosted agent mailboxes.
 * See docs/plans/2026-09-02-agent-email.md.
 */

/**
 * `agent-email.inbound.process` — one verified SNS notification from the
 * deployment's SES topic. The public route verifies the signature and the topic
 * before enqueuing, then the worker parses, routes on the receipt envelope, and
 * claims the delivery exactly once.
 */
export const AGENT_EMAIL_INBOUND_TOPIC = 'agent-email.inbound.process'
export const AGENT_EMAIL_SEND_TOPIC = 'agent-email.send'
export const AGENT_EMAIL_RETENTION_TOPIC = 'agent-email.retention.sweep'

export const AgentEmailInboundJobPayloadSchema = z.object({
  /** The inner SNS `Message` string, already signature-verified. */
  sesPayload: z.string().min(1),
  snsMessageId: z.string().min(1),
  receivedAt: z.string(),
})
export type AgentEmailInboundJobPayload = z.infer<typeof AgentEmailInboundJobPayloadSchema>

export const AgentEmailSendJobPayloadSchema = z.object({
  emailMessageId: z.string().uuid(),
  organizationId: z.string().uuid(),
})
export type AgentEmailSendJobPayload = z.infer<typeof AgentEmailSendJobPayloadSchema>

export const AgentEmailRetentionJobPayloadSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
})
export type AgentEmailRetentionJobPayload = z.infer<typeof AgentEmailRetentionJobPayloadSchema>

// ── API contracts ───────────────────────────────────────────────────────────

export const AgentMailboxSendPolicySchema = z.enum(['approval', 'auto_reply', 'auto'])
export type AgentMailboxSendPolicy = z.infer<typeof AgentMailboxSendPolicySchema>

export const AgentMailboxRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  address: z.string(),
  domain: z.string(),
  channelId: z.string().uuid(),
  status: z.enum(['active', 'suspended']),
  statusReason: z.string().nullable(),
  sendPolicy: AgentMailboxSendPolicySchema,
  displayName: z.string().nullable(),
  createdAt: z.string(),
})
export type AgentMailboxRecord = z.infer<typeof AgentMailboxRecordSchema>

export const CreateAgentMailboxBodySchema = z.object({
  localPart: z.string().min(1).max(64),
  domainId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(120).nullish(),
})
export type CreateAgentMailboxBody = z.infer<typeof CreateAgentMailboxBodySchema>

export const UpdateAgentMailboxBodySchema = z
  .object({
    sendPolicy: AgentMailboxSendPolicySchema.optional(),
    displayName: z.string().min(1).max(120).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  })
export type UpdateAgentMailboxBody = z.infer<typeof UpdateAgentMailboxBodySchema>

export const EmailConversationRecordSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  participants: z.array(z.string()),
  threadId: z.string().uuid(),
  lastMessageAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  snippet: z.string(),
  /** Derived from live rows, never a stored aggregate. */
  awaitingApproval: z.boolean(),
  hasBounce: z.boolean(),
})
export type EmailConversationRecord = z.infer<typeof EmailConversationRecordSchema>

export const EmailMessageRecordSchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(['inbound', 'outbound']),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  subject: z.string(),
  textBody: z.string(),
  htmlBody: z.string().nullable(),
  snippet: z.string(),
  classification: z.enum(['normal', 'bulk', 'dsn']),
  deliveryState: z
    .enum(['queued', 'sending', 'sent', 'delivery_unknown', 'bounced', 'complained'])
    .nullable(),
  occurredAt: z.string(),
  attachments: z.array(
    z.object({
      id: z.string().uuid(),
      filename: z.string(),
      mime: z.string(),
      sizeBytes: z.string(),
    }),
  ),
})
export type EmailMessageRecord = z.infer<typeof EmailMessageRecordSchema>

/**
 * The full frozen draft an approver is shown before authorizing a send. The
 * generic tool gate shows a 200-character redacted summary, which is not
 * informed consent for recipients, subject, body and blind copies.
 */
export const EmailDraftPreviewSchema = z.object({
  approvalId: z.string().uuid(),
  mailboxAddress: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  /** Privileged sources the run consumed beyond its own mailbox and thread. */
  externalDisclosureSources: z.array(z.string()),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
  expiresAt: z.string(),
})
export type EmailDraftPreview = z.infer<typeof EmailDraftPreviewSchema>
