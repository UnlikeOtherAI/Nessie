import { ExecutorBrowserActArgumentsSchema } from '@nessie/schemas'
import { z } from 'zod'

/**
 * Exact arguments for builtins whose human-approval requirement is declared in
 * code. These are parsed before policy, audit, or approval persistence so an
 * undeclared field cannot become part of a resumable action.
 */
export const GmailDraftSendToolInputSchema = z.object({
  draftId: z.string().uuid(),
}).strict()

/**
 * Server-authored extension of GmailDraftSendToolInputSchema. It never appears
 * in the model-facing definition: authorization reads the current projection
 * and attaches it before hashing an approval or dispatching the handler.
 */
export const AuthorizedGmailDraftSendToolInputSchema = GmailDraftSendToolInputSchema.extend({
  approvalFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const CalendarEventCreateToolInputSchema = z.object({
  addMeet: z.boolean().optional(),
  attendees: z.array(z.string()).max(100).optional(),
  calendarId: z.string().optional(),
  description: z.string().max(20_000).optional(),
  end: z.string(),
  location: z.string().max(500).optional(),
  start: z.string(),
  title: z.string().min(1).max(500),
}).strict()

export const CalendarEventUpdateToolInputSchema = z.object({
  attendees: z.array(z.string()).max(100).optional(),
  calendarId: z.string().optional(),
  description: z.string().max(20_000).optional(),
  end: z.string().optional(),
  eventId: z.string().min(1),
  location: z.string().max(500).optional(),
  start: z.string().optional(),
  title: z.string().max(500).optional(),
}).strict()

export const CalendarEventCancelToolInputSchema = z.object({
  calendarId: z.string().optional(),
  eventId: z.string().min(1),
}).strict()

export const EmailSendToolInputSchema = z.object({
  bcc: z.array(z.string()).max(50).optional(),
  cc: z.array(z.string()).max(50).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().min(1).max(100_000),
  to: z.array(z.string()).max(50).optional(),
}).strict()

/**
 * The email tool's public input plus the server-resolved proposal it will send.
 *
 * `approvalProposal` is never advertised to a model. Authorization replaces it
 * before any durable work for an ordinary call, then a continuation reuses that
 * exact sealed value after proving it came from the approval row. Keeping the
 * target and threading decision beside the body is what prevents a later
 * inference turn (or a changed conversation) from silently changing a reviewed
 * hosted-mail send.
 */
const EmailSendApprovalProposalSchema = z.object({
  bcc: z.array(z.string()).max(50),
  cc: z.array(z.string()).max(50),
  conversationId: z.string().uuid().nullable(),
  mailboxId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  to: z.array(z.string()).min(1).max(50),
}).strict()

/** Accepts a model call before the server has attached its sealed proposal. */
export const AuthorizedEmailSendToolInputSchema = EmailSendToolInputSchema.extend({
  approvalProposal: EmailSendApprovalProposalSchema.optional(),
}).strict()

/** A persisted approval and its continuation must contain the exact proposal. */
export const SealedEmailSendToolInputSchema = EmailSendToolInputSchema.extend({
  approvalProposal: EmailSendApprovalProposalSchema,
}).strict()

export const MailboxSendToolInputSchema = z.object({
  bcc: z.array(z.string()).max(50).optional(),
  cc: z.array(z.string()).max(50).optional(),
  connectionId: z.string().uuid(),
  inReplyToUid: z.number().int().positive().optional(),
  subject: z.string().max(500),
  text: z.string().max(100_000),
  to: z.array(z.string()).min(1).max(50),
}).strict()

const STRUCTURAL_TOOL_INPUT_SCHEMAS = {
  browser_act: ExecutorBrowserActArgumentsSchema,
  calendar_event_cancel: CalendarEventCancelToolInputSchema,
  calendar_event_create: CalendarEventCreateToolInputSchema,
  calendar_event_update: CalendarEventUpdateToolInputSchema,
  // `approvalProposal` is server-authored and overwritten on an initial call;
  // accepting the shape here lets the sealed continuation pass through the same
  // strict parser without a second, looser authorization path.
  email_send: AuthorizedEmailSendToolInputSchema,
  gmail_draft_send: GmailDraftSendToolInputSchema,
  mailbox_send: MailboxSendToolInputSchema,
} as const

/** Parse and canonicalize the code-declared approval tool inputs before any durable work. */
export const parseStructuralApprovalToolArgs = (
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const schema = STRUCTURAL_TOOL_INPUT_SCHEMAS[
    toolName as keyof typeof STRUCTURAL_TOOL_INPUT_SCHEMAS
  ]
  return schema ? schema.parse(args) : args
}

export const isStructuralApprovalTool = (toolName: string): boolean =>
  Object.hasOwn(STRUCTURAL_TOOL_INPUT_SCHEMAS, toolName)
