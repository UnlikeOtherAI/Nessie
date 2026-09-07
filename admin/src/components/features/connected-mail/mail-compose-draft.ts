import { ConnectedMailComposeInputSchema } from '@nessie/schemas'

export type MailComposeDraft = {
  bcc: string
  body: string
  cc: string
  /** Durable action identity for a provider draft created by this composer. */
  gmailDraftId?: string
  /** Persisted before a create/send so a reload can replay the same action. */
  requestId?: string
  /** Content-free SMTP action identity for an unconfirmed-delivery recovery. */
  mailboxSendActionId?: string
  /** A browser transport failure after dispatch began; only acknowledgement clears it. */
  mailboxSendNeedsCheck?: boolean
  /** Gmail's held-send identity survives reloads until Undo or dispatch. */
  gmailHeldSend?: { draftId: string; sendAfter: string }
  subject: string
  to: string
}

export const emptyDraft: MailComposeDraft = { bcc: '', body: '', cc: '', subject: '', to: '' }
export const recipients = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean)
export type RecipientField = 'to' | 'cc' | 'bcc'
export type RecipientErrors = Partial<Record<RecipientField, string>>

const recipientFields: RecipientField[] = ['to', 'cc', 'bcc']
const isUuid = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

/** Client parsing deliberately reuses the API's envelope-address schema. */
export const validateMailComposeRecipients = (draft: MailComposeDraft): RecipientErrors => {
  const parsed = ConnectedMailComposeInputSchema.safeParse({
    bcc: recipients(draft.bcc), body: 'validation placeholder', cc: recipients(draft.cc),
    subject: '', to: recipients(draft.to),
  })
  if (parsed.success) return {}
  return parsed.error.issues.reduce<RecipientErrors>((errors, issue) => {
    const field = issue.path[0]
    if (typeof field === 'string' && recipientFields.includes(field as RecipientField) && !errors[field as RecipientField]) {
      errors[field as RecipientField] = issue.message
    }
    return errors
  }, {})
}

const isValidDate = (value: string): boolean => Number.isFinite(Date.parse(value))
export const isFutureDate = (value: string): boolean => isValidDate(value) && Date.parse(value) > Date.now()
/** Only editable outbound fields are serializable. Reply history deliberately
 * stays in the live conversation beside this Flow, never in localStorage. */
export const reviveMailComposeDraft = (stored: unknown): MailComposeDraft | null => {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  const record = stored as Record<string, unknown>
  const hasFields = ['bcc', 'body', 'cc', 'subject', 'to'].every((key) => typeof record[key] === 'string')
  const held = record.gmailHeldSend
  const gmailHeldSend = held && typeof held === 'object' && !Array.isArray(held)
    && isUuid((held as { draftId?: unknown }).draftId)
    && typeof (held as { sendAfter?: unknown }).sendAfter === 'string'
    && isValidDate((held as { sendAfter: string }).sendAfter)
    ? { draftId: (held as { draftId: string }).draftId, sendAfter: (held as { sendAfter: string }).sendAfter }
    : undefined
  return hasFields
    ? {
      bcc: String(record.bcc), body: String(record.body), cc: String(record.cc),
      ...(isUuid(record.gmailDraftId) ? { gmailDraftId: record.gmailDraftId } : {}),
      ...(gmailHeldSend ? { gmailHeldSend } : {}),
      ...(isUuid(record.mailboxSendActionId) ? { mailboxSendActionId: record.mailboxSendActionId } : {}),
      ...(record.mailboxSendNeedsCheck === true ? { mailboxSendNeedsCheck: true } : {}),
      ...(isUuid(record.requestId) ? { requestId: record.requestId } : {}),
      subject: String(record.subject), to: String(record.to),
    }
    : null
}
