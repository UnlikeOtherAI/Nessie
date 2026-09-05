import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiClientError } from '@nessie/client-core'
import {
  ConnectedMailComposeInputSchema,
  type ConnectedMailAccountRecord,
  type ConnectedMailMessage,
} from '@nessie/schemas'

import { draftKey, useDraft } from '../../../navigation/useDraft'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import {
  type ConnectedMailDraftResult,
  type MailAddress,
  useConnectedMailDraft,
  useConnectedMailSend,
  useConnectedMailUndo,
  useMailboxSendActionStatus,
  useUpdateConnectedMailDraft,
} from '../../../facades/mail/hooks'
import { useGmailDraft, useGmailDraftStatus } from '../../../facades/gmail/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { GmailSendOutcomePanel, type GmailSendOutcome } from './GmailSendOutcomePanel'
import { GmailUnsupportedDraftPanel } from './GmailUnsupportedDraftPanel'
import { deriveMailSendOutcome } from './mail-send-outcome'

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

const emptyDraft: MailComposeDraft = { bcc: '', body: '', cc: '', subject: '', to: '' }
const recipients = (value: string): string[] => value.split(',').map((part) => part.trim()).filter(Boolean)
type RecipientField = 'to' | 'cc' | 'bcc'
type RecipientErrors = Partial<Record<RecipientField, string>>

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
const isFutureDate = (value: string): boolean => isValidDate(value) && Date.parse(value) > Date.now()
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

type ConnectedMailComposeProps = {
  account: ConnectedMailAccountRecord
  address: MailAddress
  composeId?: string
  newCompose?: boolean
  onNewComposeReady?: () => void
  onSent: () => void
  onStartNewEmail?: (composeId: string) => void
  onOpenSettings?: () => void
  gmailDraftId?: string
  replyTo?: ConnectedMailMessage
}

export const ConnectedMailCompose = ({
  account, address, composeId, gmailDraftId, newCompose, onNewComposeReady, onOpenSettings, onSent, onStartNewEmail,
  replyTo,
}: ConnectedMailComposeProps) => {
  const { me } = useAuthSession()
  const principalScope = me ? `${me.user.id}:${me.context.organizationId}` : 'unresolved-session'
  const [activeGmailDraftId, setActiveGmailDraftId] = useState<string | undefined>(gmailDraftId)
  const identity = activeGmailDraftId ? `gmail-draft:${activeGmailDraftId}` : composeId ? `new:${composeId}` : replyTo ? `reply:${replyTo.id}` : 'new:default'
  const initial = useMemo<MailComposeDraft>(() => !composeId && replyTo
    ? { ...emptyDraft, subject: replyTo.subject.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject}`, to: replyTo.from ?? '' }
    : emptyDraft, [composeId, replyTo])
  const providerDraft = useGmailDraft(address.source === 'gmail' && activeGmailDraftId ? activeGmailDraftId : null)
  const draft = useDraft(activeGmailDraftId ? null : draftKey('mail-compose', `${principalScope}:${address.source}:${address.accountId}:${identity}`), {
    initial,
    // A reply's prefilled To/subject is a baseline, not an edited draft. The
    // draft primitive must therefore still hydrate a saved held-send action.
    isEmpty: (value) => !value.gmailDraftId && !value.gmailHeldSend && !value.mailboxSendActionId
      && !value.mailboxSendNeedsCheck && !value.requestId
      && value.to === initial.to && value.cc === initial.cc && value.bcc === initial.bcc
      && value.subject === initial.subject && value.body === initial.body,
    revive: reviveMailComposeDraft,
  })
  const createDraft = useConnectedMailDraft(address)
  const updateDraft = useUpdateConnectedMailDraft(address)
  const send = useConnectedMailSend(address)
  const undo = useConnectedMailUndo(address)
  const mailboxAction = useMailboxSendActionStatus(
    address, address.source === 'mailbox' ? draft.draft.mailboxSendActionId : undefined,
  )
  const [sent, setSent] = useState<ConnectedMailDraftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recipientErrors, setRecipientErrors] = useState<RecipientErrors>({})
  const hydratedDraftRef = useRef<string | null>(null)
  const consumedNewComposeRef = useRef(false)
  const editedProviderDraftRef = useRef(false)
  const providerDraftRef = useRef<{ contentFingerprint: string; id: string } | null>(null)
  const existingProviderDraft = address.source === 'gmail' && Boolean(activeGmailDraftId)
  const unsupportedProviderDraft = existingProviderDraft && providerDraft.data?.editable === false
  const [recreateGmailDraft, setRecreateGmailDraft] = useState(false)
  const heldGmailSend = address.source === 'gmail' ? draft.draft.gmailHeldSend : undefined
  // A persisted create can recover an owner-only Undo doorway, never resend.
  const recoverableGmailDraftId = address.source === 'gmail' && !activeGmailDraftId && !heldGmailSend
    ? draft.draft.gmailDraftId
    : undefined
  // A chat doorway has its durable draft identity in the route rather than
  // localStorage. It must recover the same held action after a reload too.
  const gmailActionId = heldGmailSend?.draftId ?? activeGmailDraftId ?? recoverableGmailDraftId ?? null
  const gmailActionStatus = useGmailDraftStatus(gmailActionId)

  useEffect(() => {
    if (!newCompose || consumedNewComposeRef.current) return
    // The acknowledgement opens a fresh identity, then consumes its route
    // marker. Future visits to that identity must restore its own edits.
    consumedNewComposeRef.current = true
    draft.clear()
    onNewComposeReady?.()
  }, [draft.clear, newCompose, onNewComposeReady])

  useEffect(() => {
    setActiveGmailDraftId(gmailDraftId)
    providerDraftRef.current = null
    hydratedDraftRef.current = null
    editedProviderDraftRef.current = false
    setRecreateGmailDraft(false)
    setSent(null)
    setError(null)
    setRecipientErrors({})
  }, [address.accountId, address.source, gmailDraftId, replyTo?.id])

  // A held action is never a resend instruction. Its timer only refreshes the
  // content-free action state: an overdue send stays locked until the server
  // says whether it dispatched, sent, or became delivery-unknown.
  useEffect(() => {
    if (!heldGmailSend) return
    const delay = Date.parse(heldGmailSend.sendAfter) - Date.now()
    if (delay <= 0) return
    const timer = window.setTimeout(() => { void gmailActionStatus.refetch() }, delay)
    return () => window.clearTimeout(timer)
  }, [gmailActionStatus.refetch, heldGmailSend])

  useEffect(() => {
    const action = gmailActionStatus.data
    if (!action) return
    if (action.state === 'sending' && action.sendAfter && isFutureDate(action.sendAfter) && !heldGmailSend) {
      draft.setDraft((current) => ({
        ...current, gmailHeldSend: { draftId: action.id, sendAfter: action.sendAfter! },
      }))
      return
    }
    if (action.state === 'draft' && heldGmailSend) {
      draft.setDraft((current) => ({ ...current, gmailHeldSend: undefined }))
      return
    }
    if (action.state === 'sent') {
      draft.clear()
      setSent({ id: action.id, status: 'sent' })
    }
    if (action.state === 'discarded') {
      draft.clear()
    }
  }, [draft.clear, draft.setDraft, gmailActionStatus.data, heldGmailSend])

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
    draft.setDraft((current) => {
      const updated = typeof next === 'function' ? next(current) : next
      // A mailbox request key can already name a provider call whose browser
      // response was lost. Editing must not mint a fresh send identity.
      return updated
    })
  }

  const updateRecipient = (field: RecipientField, value: string) => {
    updateComposeDraft((current) => ({ ...current, [field]: value }))
    // A rejected submit owns the alert. Editing only removes that field's
    // previous error once it has become valid, so typing does not chatter.
    setRecipientErrors((current) => {
      if (!current[field]) return current
      const next = validateMailComposeRecipients({ ...draft.draft, [field]: value })
      return { ...current, [field]: next[field] }
    })
  }

  const submit = async () => {
    setError(null)
    if (!account.canSend) {
      setError('Sending is not available for this account. Check its connection settings.')
      return
    }
    const current = draft.draft
    const input = {
      bcc: recipients(draft.draft.bcc), body: draft.draft.body, cc: recipients(draft.draft.cc),
      // The provider-facing reply header is its RFC Message-ID, not the
      // mailbox-local UID/Gmail message id used by this reader's route.
      inReplyTo: replyTo?.messageId ?? undefined, providerThreadId: replyTo?.threadId,
      subject: draft.draft.subject, to: recipients(draft.draft.to),
    }
    const parsedInput = ConnectedMailComposeInputSchema.safeParse(input)
    const fieldErrors = validateMailComposeRecipients(current)
    setRecipientErrors(fieldErrors)
    if (Object.keys(fieldErrors).length > 0) {
      setError('Correct the recipient addresses before sending.')
      return
    }
    if (!parsedInput.success) {
      setError('Add at least one recipient and a message body.')
      return
    }
    const validInput = parsedInput.data
    const existingActionId = providerDraftRef.current?.id ?? current.gmailDraftId ?? activeGmailDraftId
    let requestId = current.requestId
    if (address.source === 'mailbox' || !existingActionId) {
      requestId ??= crypto.randomUUID()
      // Persist the action key before crossing the network boundary. The API
      // owns replay after this point, even if this tab crashes mid-request.
      draft.setDraft({ ...current, requestId })
      await draft.flush()
    }
    try {
      // Gmail always creates the reviewed provider draft before its held send;
      // IMAP/SMTP intentionally keeps this local and uses the explicit send route.
      const gmailAction = address.source === 'gmail'
        ? providerDraftRef.current
          ? await updateDraft.mutateAsync({ draftId: providerDraftRef.current.id, input: validInput })
          : existingActionId
            ? await updateDraft.mutateAsync({ draftId: existingActionId, input: validInput })
            : await createDraft.mutateAsync({
            ...validInput,
            idempotencyKey: requestId!,
          })
        : null
      if (gmailAction) {
        providerDraftRef.current = {
          contentFingerprint: gmailAction.contentFingerprint ?? '',
          id: gmailAction.id,
        }
        if (!activeGmailDraftId) {
          // A create can succeed even when the following send loses its
          // response. Keep its durable action id in the local draft so retry
          // updates/reuses it instead of creating another Gmail draft.
          draft.setDraft({ ...current, gmailDraftId: gmailAction.id, requestId })
          await draft.flush()
        }
        setRecreateGmailDraft(false)
      }
      const result = gmailAction
        ? await send.mutateAsync({
          draftId: gmailAction.id,
          expectedFingerprint: gmailAction.contentFingerprint,
        })
        : await send.mutateAsync({
          ...validInput,
          idempotencyKey: requestId!,
        })
      const heldSend = gmailAction && result.status === 'sending' && result.sendAfter
        ? { draftId: gmailAction.id, sendAfter: result.sendAfter }
        : undefined
      if (heldSend) {
        // Persist the action identity before rendering the confirmation. A
        // reload can only offer Undo; it cannot recreate or resend this draft.
        draft.setDraft({ ...current, gmailDraftId: heldSend.draftId, gmailHeldSend: heldSend, requestId })
        await draft.flush()
      } else if (address.source === 'mailbox' && result.status === 'dispatching' && result.actionId) {
        draft.setDraft({ ...current, mailboxSendActionId: result.actionId, requestId })
        await draft.flush()
      } else {
        draft.clear()
      }
      setSent({ ...result, id: result.id || result.actionId || gmailAction?.id || '' })
    } catch (cause) {
      if (address.source === 'mailbox' && !(cause instanceof ApiClientError)) {
        draft.setDraft({ ...current, mailboxSendNeedsCheck: true, requestId })
        await draft.flush()
        setError('We could not confirm whether this email was sent. It will not be resent automatically. Check the provider’s Sent mail before composing a new message.')
      } else if (cause instanceof ApiClientError && cause.code === 'DRAFT_CHANGED' && !providerDraftRef.current) {
        setRecreateGmailDraft(true)
        setError('An earlier version may already be a Gmail draft. Retry the original text to recover it, or explicitly create a new draft before sending these edits.')
      } else if (cause instanceof ApiClientError && cause.code === 'DELIVERY_UNKNOWN') {
        const details = cause.details
        const actionId = details && typeof details === 'object' && !Array.isArray(details)
          && typeof (details as { actionId?: unknown }).actionId === 'string'
          ? (details as { actionId: string }).actionId
          : undefined
        if (address.source === 'mailbox' && actionId) {
          draft.setDraft({ ...current, mailboxSendActionId: actionId, requestId })
          await draft.flush()
        }
        setError('We could not confirm whether this email was sent. It will not be resent automatically. Check the provider’s Sent mail before composing a new message.')
      } else {
        setError(cause instanceof ApiClientError && cause.code === 'DELIVERY_UNKNOWN'
          ? 'We could not confirm whether this email was sent. It will not be resent automatically.'
          : cause instanceof Error ? cause.message : 'Could not send this email.')
      }
    }
  }

  const startNewGmailDraft = () => {
    providerDraftRef.current = null
    draft.setDraft((current) => ({
      ...current, gmailDraftId: undefined, requestId: crypto.randomUUID(),
    }))
    setRecreateGmailDraft(false)
    setError(null)
  }

  const startNewEmailAfterUnknownDelivery = () => {
    // This is an explicit acknowledgement, never a retry. The old action and
    // its content are forgotten before navigation opens a blank composer.
    draft.clear()
    onStartNewEmail?.(crypto.randomUUID())
  }

  const undoGmailSend = async () => {
    const draftId = sent?.id ?? heldGmailSend?.draftId
    if (!draftId) return
    try {
      await undo.mutateAsync(draftId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not undo this send.')
      return
    }
    if (heldGmailSend) {
      draft.setDraft((current) => ({ ...current, gmailHeldSend: undefined }))
      await draft.flush()
    }
    editedProviderDraftRef.current = false
    if (activeGmailDraftId) {
      // This query is already bound to the original provider draft. Refetch
      // and hydrate directly so cached data with the same id cannot strand an
      // existing-draft composer on its pre-Undo content.
      const refreshed = await providerDraft.refetch()
      if (!refreshed.data) throw new Error('Could not reload the restored Gmail draft.')
      hydratedDraftRef.current = refreshed.data.id
      providerDraftRef.current = {
        contentFingerprint: refreshed.data.contentFingerprint,
        id: refreshed.data.id,
      }
      draft.setDraft({
        bcc: refreshed.data.bcc.join(', '), body: refreshed.data.body,
        cc: refreshed.data.cc.join(', '), subject: refreshed.data.subject,
        to: refreshed.data.to.join(', '),
      })
      setSent(null)
      return
    }
    // A freshly created draft is still using its local-draft key. Turn this
    // same composer into an existing-draft flow; the now-enabled query has a
    // new key and the hydration effect loads the restored provider content.
    hydratedDraftRef.current = null
    providerDraftRef.current = null
    setActiveGmailDraftId(draftId)
    setSent(null)
  }

  const sentConfirmation = deriveMailSendOutcome({
    gmailAction: gmailActionStatus.data, heldSend: heldGmailSend, mailboxAction: mailboxAction.data,
    mailboxActionId: draft.draft.mailboxSendActionId, mailboxNeedsCheck: draft.draft.mailboxSendNeedsCheck,
    sent, source: address.source,
  })
  const mailboxSendLocked = address.source === 'mailbox' && Boolean(draft.draft.mailboxSendNeedsCheck || (draft.draft.mailboxSendActionId && (
    mailboxAction.isPending || mailboxAction.isError || mailboxAction.data?.state !== 'ready'
  )))
  // A persisted action is ambiguous until the owner-only status endpoint says
  // it is editable again. A network failure/404 must not reopen Send.
  const gmailActionLocked = Boolean(gmailActionId && (
    gmailActionStatus.isPending
    || gmailActionStatus.isError
    || gmailActionStatus.data?.state !== 'draft'
  ))

  if (sentConfirmation) return <GmailSendOutcomePanel
    onBackToMail={onSent}
    onStartNewEmail={startNewEmailAfterUnknownDelivery}
    onUndo={() => void undoGmailSend()}
    outcome={sentConfirmation satisfies GmailSendOutcome}
    undoPending={undo.isPending}
  />

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
  if (unsupportedProviderDraft && providerDraft.data) return <GmailUnsupportedDraftPanel
    attachments={providerDraft.data.attachments} reason={providerDraft.data.unsupportedReason}
  />

  return (
    <form className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[var(--page-gutter)] py-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">From
        <input aria-label="From" className="admin-input" disabled value={account.address} />
      </label>
      <MailField error={recipientErrors.to} label="To" onChange={(to) => updateRecipient('to', to)} value={draft.draft.to} />
      <MailField error={recipientErrors.cc} label="Cc" onChange={(cc) => updateRecipient('cc', cc)} value={draft.draft.cc} />
      <MailField error={recipientErrors.bcc} label="Bcc" onChange={(bcc) => updateRecipient('bcc', bcc)} value={draft.draft.bcc} />
      <MailField label="Subject" onChange={(subject) => updateComposeDraft((value) => ({ ...value, subject }))} value={draft.draft.subject} />
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">Message
        <textarea aria-label="Message" className="admin-input min-h-44 resize-y" onChange={(event) => updateComposeDraft((value) => ({ ...value, body: event.target.value }))} value={draft.draft.body} />
      </label>
      {replyTo ? <p className="text-xs text-[color:var(--tx3)]">Replying to {replyTo.from ?? 'this message'}. Previous messages are not saved in this draft.</p> : null}
      {gmailActionStatus.isError ? <p aria-live="polite" className="text-sm text-[color:var(--danger)]" data-testid="gmail-action-status-error">We could not confirm this email’s delivery state. It will not be sent again. <button className="font-semibold text-[color:var(--accent)]" onClick={() => void gmailActionStatus.refetch()} type="button">Retry</button></p> : null}
      {mailboxAction.data?.state === 'delivery_unknown' ? <p aria-live="polite" className="text-sm text-[color:var(--danger)]" data-testid="mailbox-delivery-unknown">Delivery is unconfirmed. Check the provider’s Sent mail before composing a new message; this action will not be resent.</p> : null}
      {error ? <p aria-live="polite" className="text-sm text-[color:var(--danger)]">{error}</p> : null}
      {recreateGmailDraft ? <button className="admin-button admin-button-secondary" onClick={startNewGmailDraft} type="button">Create a new Gmail draft</button> : null}
      {!account.canSend ? <p className="text-sm text-[color:var(--tx2)]">You can prepare this email, but this account cannot send. {onOpenSettings ? <button className="font-semibold text-[color:var(--accent)]" onClick={onOpenSettings} type="button">Open mailbox settings</button> : 'Check its connection settings.'}</p> : null}
      <div><button className="admin-button admin-button-primary" disabled={!account.canSend || gmailActionLocked || mailboxSendLocked || send.isPending || createDraft.isPending || updateDraft.isPending} type="submit">{send.isPending ? 'Sending…' : 'Send email'}</button></div>
    </form>
  )
}
const MailField = ({ error, label, onChange, value }: {
  error?: string
  label: string
  onChange: (value: string) => void
  value: string
}) => (
  <FormField error={error} label={label} required={label === 'To'}>
    <Input aria-label={label} onChange={(event) => onChange(event.target.value)} value={value} />
  </FormField>
)
