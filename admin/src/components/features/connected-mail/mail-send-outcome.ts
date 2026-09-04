import type { GmailDraftActionStatus } from '../../../facades/gmail/hooks'
import type { MailboxSendActionStatus } from '../../../facades/mail/hooks'
import type { GmailSendOutcome } from './GmailSendOutcomePanel'

type SendResult = { actionId?: string; id: string; status?: string } | null
const future = (value: string): boolean => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()

export const deriveMailSendOutcome = ({
  gmailAction, heldSend, mailboxAction, mailboxActionId, mailboxNeedsCheck, sent, source,
}: {
  gmailAction: GmailDraftActionStatus | undefined
  heldSend: { draftId: string; sendAfter: string } | undefined
  mailboxAction: MailboxSendActionStatus | undefined
  mailboxActionId: string | undefined
  mailboxNeedsCheck: boolean | undefined
  sent: SendResult
  source: 'gmail' | 'mailbox'
}): GmailSendOutcome | null => {
  if (source === 'mailbox' && mailboxNeedsCheck) return { id: mailboxActionId ?? '', kind: 'delivery_unknown' }
  const mailboxSent = source === 'mailbox' && sent?.status === 'sent' ? sent
    : mailboxAction?.state === 'sent' ? { id: mailboxAction.id, status: 'sent' } : null
  if (source === 'mailbox' && (sent?.status === 'dispatching' || mailboxAction?.state === 'dispatching')) {
    return { id: mailboxActionId ?? sent?.actionId ?? '', isDispatching: true, kind: 'checking' }
  }
  if (mailboxSent) return { id: mailboxSent.id, kind: 'sent' }
  if (source !== 'gmail') return null
  const sendAfter = gmailAction?.sendAfter ?? heldSend?.sendAfter
  if (sendAfter && future(sendAfter)) return { id: heldSend?.draftId ?? gmailAction?.id ?? '', kind: 'queued' }
  if (gmailAction?.state === 'dispatching' || gmailAction?.state === 'sending') {
    return { id: gmailAction?.id ?? '', isDispatching: gmailAction.state === 'dispatching', kind: 'checking' }
  }
  if (gmailAction?.state === 'updating') return { id: gmailAction.id, kind: 'restoring' }
  if (gmailAction?.state === 'update_unknown') return { id: gmailAction.id, kind: 'update_unknown' }
  if (gmailAction?.state === 'delivery_unknown') return { id: gmailAction.id, kind: 'delivery_unknown' }
  if (gmailAction?.state === 'sent' || sent?.status === 'sent') return { id: sent?.id ?? gmailAction?.id ?? '', kind: 'sent' }
  return null
}
