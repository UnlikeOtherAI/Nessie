import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MailSurfaceDoorwayMetadataSchema,
  type ConnectedMailAccountRecord,
  type ConnectedMailThreadSummary,
  type MailSurfaceDoorwayMetadata,
} from '@nessie/schemas'
import { useNavigate } from 'react-router-dom'

import { Dialog } from '../../shared/Dialog'
import { QueryState } from '../../shared/QueryState'
import { ConnectedMailCompose } from '../connected-mail/ConnectedMailCompose'
import { ConnectedMailConversationView } from '../connected-mail/ConnectedMailConversation'
import { MailboxThreadList, MailboxWorkspace, type MailboxThreadSummary } from '../mailbox/MailboxWorkspace'
import { mailPath, useConnectedMailAccounts, useConnectedMailConversation, useConnectedMailThreads } from '../../../facades/mail/hooks'
import { connectedMailSettingsPath } from '../../../facades/mail/settings-path'
import { useNavigationLayout } from '../../../lib/mobile-shell'

export type MailSurfaceDoorway = MailSurfaceDoorwayMetadata

export const readMailSurfaceDoorway = (metadata: Record<string, unknown> | undefined): MailSurfaceDoorway | null => {
  const parsed = MailSurfaceDoorwayMetadataSchema.safeParse(metadata?.mailSurfaceDoorway)
  return parsed.success ? parsed.data : null
}

const doorwayPath = (doorway: MailSurfaceDoorway): string => {
  const root = mailPath({ accountId: doorway.accountId, source: doorway.source })
  if (doorway.mode === 'thread' && doorway.threadId) return `${root}/threads/${encodeURIComponent(doorway.threadId)}`
  if (doorway.mode !== 'compose') return root
  const params = new URLSearchParams()
  if (doorway.threadId) params.set('threadId', doorway.threadId)
  if (doorway.draftId) params.set('draftId', doorway.draftId)
  return `${root}/compose${params.size ? `?${params}` : ''}`
}

const canOpen = (account: ConnectedMailAccountRecord, doorway: MailSurfaceDoorway): boolean =>
  doorway.mode === 'compose' ? account.canCompose : account.canRead

const findAccount = (accounts: ConnectedMailAccountRecord[] | undefined, doorway: MailSurfaceDoorway) =>
  accounts?.find((account) =>
    account.id === doorway.accountId && account.source === doorway.source && canOpen(account, doorway),
  ) ?? null

const asMailboxThread = (thread: ConnectedMailThreadSummary): MailboxThreadSummary => ({
  awaitingApproval: false,
  hasAttachments: thread.hasAttachments,
  hasBounce: false,
  id: thread.id,
  lastMessageAt: thread.receivedAt ?? new Date(0).toISOString(),
  messageCount: thread.messageCount,
  participants: thread.from ? [thread.from] : [],
  snippet: thread.snippet,
  subject: thread.subject,
  unread: thread.unread,
})

/** The account handoff is the shared mailbox vocabulary, not prose that makes
 * a person leave chat merely to see which conversations need their attention. */
const MailSurfaceAccountPreview = ({
  account,
  onSelect,
}: {
  account: ConnectedMailAccountRecord
  onSelect: (threadId: string) => void
}) => {
  const threads = useConnectedMailThreads({ accountId: account.id, source: account.source }, {
    pageSize: 10, query: '', unreadOnly: false,
  })
  const items = threads.data?.items ?? []
  return (
    <MailboxWorkspace
      conversation={<p className="p-3 text-sm text-[color:var(--tx2)]">Choose a conversation to open it in Mail.</p>}
      conversationList={(
        <QueryState emptyLabel="No conversations are available." errorLabel="Could not load this mailbox." isEmpty={items.length === 0} loadingLabel="Loading mail…" query={threads}>
          {() => <MailboxThreadList ariaLabel="Mail conversations" onSelect={onSelect} threads={items.map(asMailboxThread)} />}
        </QueryState>
      )}
      layout="single"
    />
  )
}

/** A message-local, content-free pointer. It rechecks entitlement before an
 * offer and disables the live body query until the shared overlay is visible. */
export const MailSurfaceDoorwayChip = ({ messageId, metadata }: {
  messageId: string
  metadata: Record<string, unknown> | undefined
}) => {
  const doorway = readMailSurfaceDoorway(metadata)
  const navigate = useNavigate()
  const layout = useNavigationLayout()
  const accounts = useConnectedMailAccounts()
  const [open, setOpen] = useState(false)
  const [account, setAccount] = useState<ConnectedMailAccountRecord | null>(null)
  const [accessError, setAccessError] = useState<string | null>(null)
  const targetRef = useRef<HTMLDivElement | null>(null)
  const storageKey = useMemo(() => doorway ? `mail-doorway-offered:${messageId}` : null, [doorway, messageId])
  const conversation = useConnectedMailConversation(
    doorway ? { accountId: doorway.accountId, source: doorway.source } : null,
    doorway?.threadId,
    open && Boolean(account),
  )

  const checkAndOpen = async (): Promise<ConnectedMailAccountRecord | null> => {
    if (!doorway) return null
    setAccessError(null)
    try {
      const refreshed = await accounts.refetch({ throwOnError: true })
      const next = findAccount(refreshed.data, doorway)
      if (!next) { setAccessError('This email is no longer available to you. Check mailbox settings.'); return null }
      setAccount(next)
      setOpen(true)
      return next
    } catch {
      setAccessError('Could not check access to this email. Try again.')
      return null
    }
  }

  useEffect(() => {
    if (!storageKey || !targetRef.current || !doorway) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      try {
        if (window.sessionStorage.getItem(storageKey) || window.sessionStorage.getItem('mail-doorway-overlay-open')) return
        window.sessionStorage.setItem(storageKey, 'offered')
        window.sessionStorage.setItem('mail-doorway-overlay-open', messageId)
        void checkAndOpen().then((account) => {
          if (account) return
          try { window.sessionStorage.removeItem('mail-doorway-overlay-open') } catch { /* no-op */ }
        })
      } catch { /* Explicit Open mail remains available when storage is disabled. */ }
      observer.disconnect()
    }, { threshold: 0.5 })
    observer.observe(targetRef.current)
    return () => observer.disconnect()
  }, [doorway, messageId, storageKey])

  if (!doorway) return null
  const matchingAccount = accounts.data?.find((candidate) =>
    candidate.id === doorway.accountId && candidate.source === doorway.source,
  )
  const title = doorway.mode === 'compose' ? 'Email draft ready' : doorway.mode === 'thread' ? 'Email ready to review' : 'Mail ready to review'
  const close = () => {
    try { window.sessionStorage.removeItem('mail-doorway-overlay-open') } catch { /* no-op */ }
    setOpen(false)
    setAccount(null)
  }
  const openMail = async () => {
    if (!await checkAndOpen()) return
    close()
    navigate(doorwayPath(doorway))
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="mail-surface-doorway" ref={targetRef}>
      <span className="text-xs text-[color:var(--tx2)]">{title}</span>
      <button className="admin-button admin-button-secondary admin-button-compact" onClick={() => void checkAndOpen()} type="button">Open mail</button>
      {accessError ? <span aria-live="polite" className="text-xs text-[color:var(--danger)]">{accessError}</span> : null}
      {accessError && matchingAccount ? <button className="text-xs font-semibold text-[color:var(--accent)]" onClick={() => navigate(connectedMailSettingsPath(matchingAccount))} type="button">Open mailbox settings</button> : null}
      <Dialog description="Mail access is checked when this opens." onClose={close} open={open} size={layout === 'single' ? 'full' : 'xl'} title={title}>
        <div className="min-h-0 p-4">
          {doorway.mode === 'thread' && conversation.data ? <ConnectedMailConversationView conversation={conversation.data} onReply={(message) => { close(); navigate(`${mailPath({ accountId: doorway.accountId, source: doorway.source })}/compose?threadId=${encodeURIComponent(message.threadId)}&reply=${encodeURIComponent(message.id)}`) }} /> : null}
          {doorway.mode === 'compose' && account ? <ConnectedMailCompose account={account} address={{ accountId: account.id, source: account.source }} gmailDraftId={doorway.draftId} onOpenSettings={() => navigate(connectedMailSettingsPath(account))} onSent={close} /> : null}
          {doorway.mode === 'account' && account ? <MailSurfaceAccountPreview account={account} onSelect={(threadId) => { close(); navigate(`${mailPath({ accountId: account.id, source: account.source })}/threads/${encodeURIComponent(threadId)}`) }} /> : null}
          {conversation.isError ? <p aria-live="polite" className="text-sm text-[color:var(--danger)]">Could not load this email. Try opening it again.</p> : null}
          <button className="mt-3 admin-button admin-button-primary" onClick={() => void openMail()} type="button">Open full mail</button>
        </div>
      </Dialog>
    </div>
  )
}
