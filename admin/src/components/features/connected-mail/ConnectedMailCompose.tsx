import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiClientError } from '@nessie/client-core'
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
import { useAuthSession } from '../../../providers/AuthSessionProvider'

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
  onOpenSettings?: () => void
  gmailDraftId?: string
  replyTo?: ConnectedMailMessage
}

export const ConnectedMailCompose = ({
  account, address, gmailDraftId, onOpenSettings, onSent, replyTo,
}: ConnectedMailComposeProps) => {
  const { me } = useAuthSession()
  const principalScope = me ? `${me.user.id}:${me.context.organizationId}` : 'unresolved-session'
  const [activeGmailDraftId, setActiveGmailDraftId] = useState<string | undefined>(gmailDraftId)
  const identity = activeGmailDraftId ? `gmail-draft:${activeGmailDraftId}` : replyTo ? `reply:${replyTo.id}` : 'new'
  const initial = useMemo<MailComposeDraft>(() => replyTo
    ? { ...emptyDraft, subject: replyTo.subject.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject}`, to: replyTo.from ?? '' }
    : emptyDraft, [replyTo])
  const providerDraft = useGmailDraft(address.source === 'gmail' && activeGmailDraftId ? activeGmailDraftId : null)
  const draft = useDraft(activeGmailDraftId ? null : draftKey('mail-compose', `${principalScope}:${address.source}:${address.accountId}:${identity}`), {
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
  const createIdempotencyKeyRef = useRef<string | null>(null)
  const editedProviderDraftRef = useRef(false)
  const providerDraftRef = useRef<{ contentFingerprint: string; id: string } | null>(null)
  const existingProviderDraft = address.source === 'gmail' && Boolean(activeGmailDraftId)
  const mailboxSendIdempotencyKeyRef = useRef<string | null>(null)
  const [recreateGmailDraft, setRecreateGmailDraft] = useState(false)

  useEffect(() => {
    setActiveGmailDraftId(gmailDraftId)
    providerDraftRef.current = null
    hydratedDraftRef.current = null
    editedProviderDraftRef.current = false
  }, [gmailDraftId])

  // Provider draft content is editable, but it is not a local unsent draft:
  // never copy it into localStorage when a doorway opens an existing Gmail draft.
  useEffect(() => {
    if (
      !providerDraft.data
      || providerDraft.data.id !== activeGmailDraftId
      || draft.restored
      || editedProviderDraftRef.current
      || hydratedDraftRef.current === providerDraft.data.id
    ) return
    hydratedDraftRef.current = providerDraft.data.id
    providerDraftRef.current = {
      contentFingerprint: providerDraft.data.contentFingerprint,
      id: providerDraft.data.id,
    }
    draft.setDraft({
      bcc: providerDraft.data.bcc.join(', '), body: providerDraft.data.body,
      cc: providerDraft.data.cc.join(', '), subject: providerDraft.data.subject,
      to: providerDraft.data.to.join(', '),
    })
  }, [draft.restored, draft.setDraft, providerDraft.data])

  const updateComposeDraft = (next: MailComposeDraft | ((current: MailComposeDraft) => MailComposeDraft)) => {
    editedProviderDraftRef.current = true
    draft.setDraft(next)
  }

  const submit = async () => {
    setError(null)
    if (!account.canSend) {
      setError('Sending is not available for this account. Check its connection settings.')
      return
    }
    const input = {
      bcc: recipients(draft.draft.bcc), body: draft.draft.body, cc: recipients(draft.draft.cc),
      // The provider-facing reply header is its RFC Message-ID, not the
      // mailbox-local UID/Gmail message id used by this reader's route.
      inReplyTo: replyTo?.messageId ?? undefined, providerThreadId: replyTo?.threadId,
      subject: draft.draft.subject, to: recipients(draft.draft.to),
    }
    if (!input.to.length || !input.body) { setError('Add at least one recipient and a message body.'); return }
    try {
      // Gmail always creates the reviewed provider draft before its held send;
      // IMAP/SMTP intentionally keeps this local and uses the explicit send route.
      const providerAction = address.source === 'gmail'
        ? providerDraftRef.current
          ? await updateDraft.mutateAsync({ draftId: providerDraftRef.current.id, input })
          : activeGmailDraftId
            ? await updateDraft.mutateAsync({ draftId: activeGmailDraftId, input })
            : await createDraft.mutateAsync({
            ...input,
            idempotencyKey: createIdempotencyKeyRef.current ??= crypto.randomUUID(),
          })
        : null
      if (providerAction) {
        providerDraftRef.current = {
          contentFingerprint: providerAction.contentFingerprint ?? '',
          id: providerAction.id,
        }
        setActiveGmailDraftId(providerAction.id)
        setRecreateGmailDraft(false)
      }
      const result = address.source === 'gmail'
        ? await send.mutateAsync({
          draftId: providerAction!.id,
          expectedFingerprint: providerAction!.contentFingerprint,
        })
        : await send.mutateAsync({
          ...input,
          idempotencyKey: mailboxSendIdempotencyKeyRef.current ??= crypto.randomUUID(),
        })
      setSent({ ...result, id: result.id || providerAction?.id || '' })
      draft.clear()
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === 'DRAFT_CHANGED' && !providerDraftRef.current) {
        setRecreateGmailDraft(true)
        setError('An earlier version may already be a Gmail draft. Retry the original text to recover it, or explicitly create a new draft before sending these edits.')
      } else {
        setError(cause instanceof ApiClientError && cause.code === 'DELIVERY_UNKNOWN'
          ? 'We could not confirm whether this email was sent. It will not be resent automatically.'
          : cause instanceof Error ? cause.message : 'Could not send this email.')
      }
    }
  }

  const startNewGmailDraft = () => {
    createIdempotencyKeyRef.current = crypto.randomUUID()
    providerDraftRef.current = null
    setRecreateGmailDraft(false)
    setError(null)
  }

  const undoGmailSend = async () => {
    if (!sent?.id) return
    await undo.mutateAsync(sent.id)
    providerDraftRef.current = null
    hydratedDraftRef.current = null
    editedProviderDraftRef.current = false
    setActiveGmailDraftId(sent.id)
    setSent(null)
    await providerDraft.refetch()
  }

  if (sent) return (
    <section className="px-[var(--page-gutter)] py-6" data-testid="connected-mail-sent">
      <p aria-live="polite" className="text-sm text-[color:var(--tx)]">
        {address.source === 'gmail' ? 'Your email is queued to send.' : 'Your email was sent.'}
      </p>
      {address.source === 'gmail' && sent.id ? <button className="mt-3 admin-button admin-button-secondary" disabled={undo.isPending} onClick={() => void undoGmailSend()} type="button">Undo send</button> : null}
      <button className="ml-2 mt-3 admin-button admin-button-primary" onClick={onSent} type="button">Back to mail</button>
    </section>
  )

  // A provider-owned Gmail draft is never an empty editable form. Its live
  // content must arrive first, and a late refetch may not replace words the
  // person has already started editing.
  if (existingProviderDraft && hydratedDraftRef.current !== activeGmailDraftId) {
    if (providerDraft.isError) return (
      <section className="px-[var(--page-gutter)] py-6">
        <p aria-live="polite" className="text-sm text-[color:var(--danger)]">Could not load this Gmail draft. It may no longer be available.</p>
        <button className="mt-3 admin-button admin-button-secondary" onClick={() => void providerDraft.refetch()} type="button">Retry</button>
        {onOpenSettings ? <button className="ml-2 mt-3 admin-button admin-button-secondary" onClick={onOpenSettings} type="button">Open mailbox settings</button> : null}
      </section>
    )
    return <p className="px-[var(--page-gutter)] py-6 text-sm text-[color:var(--tx2)]">Loading Gmail draft…</p>
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[var(--page-gutter)] py-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">From
        <input aria-label="From" className="admin-input" disabled value={account.address} />
      </label>
      <MailField label="To" onChange={(to) => updateComposeDraft((value) => ({ ...value, to }))} value={draft.draft.to} />
      <MailField label="Cc" onChange={(cc) => updateComposeDraft((value) => ({ ...value, cc }))} value={draft.draft.cc} />
      <MailField label="Bcc" onChange={(bcc) => updateComposeDraft((value) => ({ ...value, bcc }))} value={draft.draft.bcc} />
      <MailField label="Subject" onChange={(subject) => updateComposeDraft((value) => ({ ...value, subject }))} value={draft.draft.subject} />
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Message
        <textarea aria-label="Message" className="admin-input min-h-44 resize-y" onChange={(event) => updateComposeDraft((value) => ({ ...value, body: event.target.value }))} value={draft.draft.body} />
      </label>
      {replyTo ? <p className="text-xs text-[color:var(--tx3)]">Replying to {replyTo.from ?? 'this message'}. Previous messages are not saved in this draft.</p> : null}
      {error ? <p aria-live="polite" className="text-sm text-[color:var(--danger)]">{error}</p> : null}
      {recreateGmailDraft ? <button className="admin-button admin-button-secondary" onClick={startNewGmailDraft} type="button">Create a new Gmail draft</button> : null}
      {!account.canSend ? <p className="text-sm text-[color:var(--tx2)]">You can prepare this email, but this account cannot send. {onOpenSettings ? <button className="font-semibold text-[color:var(--accent)]" onClick={onOpenSettings} type="button">Open mailbox settings</button> : 'Check its connection settings.'}</p> : null}
      <div><button className="admin-button admin-button-primary" disabled={!account.canSend || send.isPending || createDraft.isPending || updateDraft.isPending} type="submit">{send.isPending ? 'Sending…' : 'Send email'}</button></div>
    </form>
  )
}

const MailField = ({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) => (
  <label className="grid gap-1 text-sm text-[color:var(--tx2)]">{label}
    <input aria-label={label} className="admin-input" onChange={(event) => onChange(event.target.value)} value={value} />
  </label>
)
