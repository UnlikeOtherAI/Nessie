import { z } from 'zod'

/** Live, provider-owned mail. These records are deliberately never persisted. */
export const ConnectedMailSourceSchema = z.enum(['gmail', 'mailbox'])
export type ConnectedMailSource = z.infer<typeof ConnectedMailSourceSchema>

/** The only durable pointer an agent may leave to the connected-mail surface. */
export const MailSurfaceDoorwayModeSchema = z.enum(['account', 'thread', 'compose'])
export type MailSurfaceDoorwayMode = z.infer<typeof MailSurfaceDoorwayModeSchema>

/**
 * A provider-neutral, content-free handoff to Mail.
 *
 * This is deliberately a pointer rather than a mail preview. Message metadata
 * is visible to everyone who can read the agent message, while mail content is
 * fetched live through its own entitlement-gated route. Do not add subject,
 * recipient, search, snippet, or body fields here.
 */
export const MailSurfaceDoorwayMetadataSchema = z
  .object({
    source: ConnectedMailSourceSchema,
    accountId: z.string().min(1).max(200),
    mode: MailSurfaceDoorwayModeSchema,
    threadId: z.string().min(1).max(500).optional(),
    draftId: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'account' && (value.threadId || value.draftId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An account doorway cannot carry a thread or draft reference.',
      })
    }
    if (value.mode === 'thread' && (!value.threadId || value.draftId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A thread doorway needs only a thread reference.',
      })
    }
    if (value.mode === 'compose' && value.threadId && value.draftId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A compose doorway may name a draft or reply thread, not both.',
      })
    }
    if (value.draftId && value.source !== 'gmail') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only Gmail compose doorways may name a provider draft.',
      })
    }
  })
export type MailSurfaceDoorwayMetadata = z.infer<typeof MailSurfaceDoorwayMetadataSchema>

/** Model input for the safe presentation tool. Identical to durable metadata. */
export const MailPresentToolInputSchema = MailSurfaceDoorwayMetadataSchema
export type MailPresentToolInput = z.infer<typeof MailPresentToolInputSchema>

export const MailPresentToolOutputSchema = z
  .object({
    messageId: z.string().uuid(),
    reviewUrl: z.string().min(1).max(2000),
  })
  .strict()
export type MailPresentToolOutput = z.infer<typeof MailPresentToolOutputSchema>

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
  /** RFC 5322 Message-ID, normalized by the provider when one was supplied. */
  messageId: z.string().max(1000).nullable(),
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
  unreadOnly: z.union([
    z.boolean(),
    z.enum(['true', 'false']).transform((value) => value === 'true'),
  ]).optional(),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
}).strict()
export type ConnectedMailThreadsQuery = z.infer<typeof ConnectedMailThreadsQuerySchema>

export const ConnectedMailConversationParamsSchema = z.object({
  source: ConnectedMailSourceSchema,
  accountId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(500),
}).strict()
export type ConnectedMailConversationParams = z.infer<typeof ConnectedMailConversationParamsSchema>

const headerText = (max: number) => z.string().max(max).refine(
  (value) => !/[\r\n]/.test(value),
  'Mail headers cannot contain a line break.',
)
const recipient = z.string().trim().min(3).max(320).refine(
  (value) => !/[\r\n]/.test(value),
  'Mail headers cannot contain a line break.',
)
const recipients = z.array(recipient).min(1).max(50)
const optionalRecipients = z.array(recipient).max(50).optional()

/** `from` is intentionally absent: the server derives it from the account. */
export const ConnectedMailComposeInputSchema = z.object({
  to: recipients,
  cc: optionalRecipients,
  bcc: optionalRecipients,
  subject: headerText(500),
  body: z.string().min(1).max(100_000),
  providerThreadId: z.string().min(1).max(500).optional(),
  inReplyTo: z.string().min(1).max(1000).refine(
    (value) => !/[\r\n]/.test(value),
    'Mail headers cannot contain a line break.',
  ).optional(),
}).strict()
export type ConnectedMailComposeInput = z.infer<typeof ConnectedMailComposeInputSchema>

/** A create-draft retry must reuse this id after a lost browser response. */
export const ConnectedMailDraftCreateInputSchema = ConnectedMailComposeInputSchema.extend({
  idempotencyKey: z.string().uuid(),
}).strict()
export type ConnectedMailDraftCreateInput = z.infer<typeof ConnectedMailDraftCreateInputSchema>

export const ConnectedMailSendInputSchema = ConnectedMailComposeInputSchema.extend({
  expectedFingerprint: z.string().min(1).max(200).optional(),
}).strict()
export type ConnectedMailSendInput = z.infer<typeof ConnectedMailSendInputSchema>

/** SMTP sends use this id to replay a known action, never a provider call. */
export const ConnectedMailboxSendInputSchema = ConnectedMailComposeInputSchema.extend({
  idempotencyKey: z.string().uuid(),
}).strict()
export type ConnectedMailboxSendInput = z.infer<typeof ConnectedMailboxSendInputSchema>

export const ConnectedMailGmailDraftSendInputSchema = z.object({
  draftId: z.string().uuid(),
  expectedFingerprint: z.string().min(1).max(200),
}).strict()
export type ConnectedMailGmailDraftSendInput = z.infer<typeof ConnectedMailGmailDraftSendInputSchema>
