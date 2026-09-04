import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectedMailAccountRecord, ConnectedMailMessage } from '@nessie/schemas'

import { draftKey, useDraft } from '../../../navigation/useDraft'
import {
  type ConnectedMailDraftResult,
  type MailAddress,
  useConnectedMailDraft,
  useConnectedMailSend,
  useConnectedMailUndo,
  useUpdateConnectedMailDraft,
} from '../../../facades/mail/hooks'
import { useGmailDraft } from '../../../facades/gmail/hooks'

export type MailComposeDraft = { bcc: string; body: string; cc: string; subject: string; to: string }

const emptyDraft: MailComposeDraft = { bcc: '', body: '', cc: '', subject: '', to: '' }
const recipients = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean)

/** Only editable outbound fields are serializable. Reply history deliberately
 * stays in the live conversation beside this Flow, never in localStorage. */
export const reviveMailComposeDraft = (stored: unknown): MailComposeDraft | null => {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  const record = stored as Record<string, unknown>
  return ['bcc', 'body', 'cc', 'subject', 'to'].every((key) => typeof record[key] === 'string')
    ? {
      bcc: String(record.bcc), body: String(record.body), cc: String(record.cc),
      subject: String(record.subject), to: String(record.to),
    }
    : null
}

type ConnectedMailComposeProps = {
  account: ConnectedMailAccountRecord
  address: MailAddress
  onSent: () => void
  gmailDraftId?: string
  replyTo?: ConnectedMailMessage
}

export const ConnectedMailCompose = ({
  account, address, gmailDraftId, onSent, replyTo,
}: ConnectedMailComposeProps) => {
  const identity = gmailDraftId ? `gmail-draft:${gmailDraftId}` : replyTo ? `reply:${replyTo.id}` : 'new'
  const initial = useMemo<MailComposeDraft>(() => replyTo
    ? { ...emptyDraft, subject: replyTo.subject.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject}`, to: replyTo.from ?? '' }
    : emptyDraft, [replyTo])
  const providerDraft = useGmailDraft(address.source === 'gmail' && gmailDraftId ? gmailDraftId : null)
  const draft = useDraft(gmailDraftId ? null : draftKey('mail-compose', `${address.source}:${address.accountId}:${identity}`), {
    initial,
    isEmpty: (value) => !value.to && !value.cc && !value.bcc && !value.subject && !value.body,
    revive: reviveMailComposeDraft,
  })
  const createDraft = useConnectedMailDraft(address)
  const updateDraft = useUpdateConnectedMailDraft(address)
  const send = useConnectedMailSend(address)
  const undo = useConnectedMailUndo(address)
  const [sent, setSent] = useState<ConnectedMailDraftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hydratedDraftRef = useRef<string | null>(null)

  // Provider draft content is editable, but it is not a local unsent draft:
  // never copy it into localStorage when a doorway opens an existing Gmail draft.
  useEffect(() => {
    if (!providerDraft.data || draft.restored || hydratedDraftRef.current === providerDraft.data.id) return
    hydratedDraftRef.current = providerDraft.data.id
    draft.setDraft({
      bcc: providerDraft.data.bcc.join(', '), body: providerDraft.data.body,
      cc: providerDraft.data.cc.join(', '), subject: providerDraft.data.subject,
      to: providerDraft.data.to.join(', '),
    })
  }, [draft.restored, draft.setDraft, providerDraft.data])

  const submit = async () => {
    setError(null)
    const input = {
      bcc: recipients(draft.draft.bcc), body: draft.draft.body, cc: recipients(draft.draft.cc),
      inReplyTo: replyTo?.id, providerThreadId: replyTo?.threadId,
      subject: draft.draft.subject, to: recipients(draft.draft.to),
    }
    if (!input.to.length || !input.body) { setError('Add at least one recipient and a message body.'); return }
    try {
      // Gmail always creates the reviewed provider draft before its held send;
      // IMAP/SMTP intentionally keeps this local and uses the explicit send route.
      const providerDraft = address.source === 'gmail'
        ? gmailDraftId
          ? await updateDraft.mutateAsync({ draftId: gmailDraftId, input })
          : await createDraft.mutateAsync(input)
        : null
      const result = address.source === 'gmail'
        ? await send.mutateAsync({
          draftId: providerDraft!.id || gmailDraftId!,
          expectedFingerprint: providerDraft!.contentFingerprint,
        })
        : await send.mutateAsync(input)
      setSent({ ...result, id: result.id || providerDraft?.id || '' })
      draft.clear()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send this email.')
    }
  }

  if (sent) return (
    <section className="px-[var(--page-gutter)] py-6" data-testid="connected-mail-sent">
      <p aria-live="polite" className="text-sm text-[color:var(--tx)]">Your email is queued to send.</p>
      {address.source === 'gmail' && sent.id ? <button className="mt-3 admin-button admin-button-secondary" disabled={undo.isPending} onClick={() => void undo.mutateAsync(sent.id).then(onSent)} type="button">Undo send</button> : null}
      <button className="ml-2 mt-3 admin-button admin-button-primary" onClick={onSent} type="button">Back to mail</button>
    </section>
  )

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[var(--page-gutter)] py-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">From
        <input aria-label="From" className="admin-input" disabled value={account.address} />
      </label>
      <MailField label="To" onChange={(to) => draft.setDraft((value) => ({ ...value, to }))} value={draft.draft.to} />
      <MailField label="Cc" onChange={(cc) => draft.setDraft((value) => ({ ...value, cc }))} value={draft.draft.cc} />
      <MailField label="Bcc" onChange={(bcc) => draft.setDraft((value) => ({ ...value, bcc }))} value={draft.draft.bcc} />
      <MailField label="Subject" onChange={(subject) => draft.setDraft((value) => ({ ...value, subject }))} value={draft.draft.subject} />
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Message
        <textarea aria-label="Message" className="admin-input min-h-44 resize-y" onChange={(event) => draft.setDraft((value) => ({ ...value, body: event.target.value }))} value={draft.draft.body} />
      </label>
      {replyTo ? <p className="text-xs text-[color:var(--tx3)]">Replying to {replyTo.from ?? 'this message'}. Previous messages are not saved in this draft.</p> : null}
      {error ? <p aria-live="polite" className="text-sm text-[color:var(--danger)]">{error}</p> : null}
      <div><button className="admin-button admin-button-primary" disabled={send.isPending || createDraft.isPending || updateDraft.isPending} type="submit">{send.isPending ? 'Sending…' : 'Send email'}</button></div>
    </form>
  )
}

const MailField = ({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) => (
  <label className="grid gap-1 text-sm text-[color:var(--tx2)]">{label}
    <input aria-label={label} className="admin-input" onChange={(event) => onChange(event.target.value)} value={value} />
  </label>
)
