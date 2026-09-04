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

export const MailboxSendToolInputSchema = z.object({
  bcc: z.array(z.string()).max(50).optional(),
  cc: z.array(z.string()).max(50).optional(),
  connectionId: z.string().uuid().optional(),
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
  email_send: EmailSendToolInputSchema,
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
