import { z } from 'zod'

/** Live, provider-owned mail. These records are deliberately never persisted. */
export const ConnectedMailSourceSchema = z.enum(['gmail', 'mailbox'])
export type ConnectedMailSource = z.infer<typeof ConnectedMailSourceSchema>

export const ConnectedMailAccountRecordSchema = z.object({
  id: z.string().min(1),
  source: ConnectedMailSourceSchema,
  label: z.string().min(1).max(120),
  address: z.string().min(3).max(320),
  scope: z.enum(['personal', 'shared']),
  status: z.enum(['active', 'needs_reauthorization', 'disabled']),
  canRead: z.boolean(),
  canCompose: z.boolean(),
  canSend: z.boolean(),
})
export type ConnectedMailAccountRecord = z.infer<typeof ConnectedMailAccountRecordSchema>

export const ConnectedMailAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
})
export type ConnectedMailAttachment = z.infer<typeof ConnectedMailAttachmentSchema>

export const ConnectedMailThreadSummarySchema = z.object({
  id: z.string().min(1),
  from: z.string().max(1000).nullable(),
  subject: z.string().max(1000),
  snippet: z.string().max(1000),
  receivedAt: z.string().datetime().nullable(),
  unread: z.boolean(),
  hasAttachments: z.boolean(),
  messageCount: z.number().int().positive(),
})
export type ConnectedMailThreadSummary = z.infer<typeof ConnectedMailThreadSummarySchema>

export const ConnectedMailPageSchema = <T extends z.ZodTypeAny>(item: T) => z.object({
  items: z.array(item),
  nextCursor: z.string().min(1).optional(),
  previousCursor: z.string().min(1).optional(),
  /** Provider supplied estimate only; consumers must not display it as exact. */
  estimate: z.number().int().nonnegative().optional(),
})

export const ConnectedMailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  from: z.string().max(1000).nullable(),
  to: z.array(z.string().max(1000)).max(100),
  cc: z.array(z.string().max(1000)).max(100),
  subject: z.string().max(1000),
  receivedAt: z.string().datetime().nullable(),
  body: z.string().max(100_000),
  bodyFormat: z.enum(['text', 'html']),
  blockedRemoteContent: z.boolean(),
  attachments: z.array(ConnectedMailAttachmentSchema).max(100),
  inReplyTo: z.string().max(1000).nullable(),
})
export type ConnectedMailMessage = z.infer<typeof ConnectedMailMessageSchema>

export const ConnectedMailConversationSchema = z.object({
  id: z.string().min(1),
  messages: z.array(ConnectedMailMessageSchema).max(200),
  /** A bounded provider slice can have unseen older members. */
  earlierMessagesMayExist: z.boolean(),
})
export type ConnectedMailConversation = z.infer<typeof ConnectedMailConversationSchema>

export const ConnectedMailAccountsQuerySchema = z.object({}).strict()
export type ConnectedMailAccountsQuery = z.infer<typeof ConnectedMailAccountsQuerySchema>

export const ConnectedMailThreadsQuerySchema = z.object({
  cursor: z.string().min(1).max(2000).optional(),
  query: z.string().trim().min(1).max(500).optional(),
  unreadOnly: z.coerce.boolean().optional(),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
}).strict()
export type ConnectedMailThreadsQuery = z.infer<typeof ConnectedMailThreadsQuerySchema>

export const ConnectedMailConversationParamsSchema = z.object({
  source: ConnectedMailSourceSchema,
  accountId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(500),
}).strict()
export type ConnectedMailConversationParams = z.infer<typeof ConnectedMailConversationParamsSchema>

const recipients = z.array(z.string().trim().min(3).max(320)).min(1).max(50)
const optionalRecipients = z.array(z.string().trim().min(3).max(320)).max(50).optional()

/** `from` is intentionally absent: the server derives it from the account. */
export const ConnectedMailComposeInputSchema = z.object({
  to: recipients,
  cc: optionalRecipients,
  bcc: optionalRecipients,
  subject: z.string().max(500),
  body: z.string().min(1).max(100_000),
  providerThreadId: z.string().min(1).max(500).optional(),
  inReplyTo: z.string().min(1).max(1000).optional(),
}).strict()
export type ConnectedMailComposeInput = z.infer<typeof ConnectedMailComposeInputSchema>

export const ConnectedMailSendInputSchema = ConnectedMailComposeInputSchema.extend({
  expectedFingerprint: z.string().min(1).max(200).optional(),
  immediate: z.boolean().optional(),
}).strict()
export type ConnectedMailSendInput = z.infer<typeof ConnectedMailSendInputSchema>
