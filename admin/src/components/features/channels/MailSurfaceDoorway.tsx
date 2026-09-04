import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'

import { Dialog } from '../../shared/Dialog'
import { ConnectedMailConversationView } from '../connected-mail/ConnectedMailConversation'
import { mailPath, useConnectedMailAccounts, useConnectedMailConversation } from '../../../facades/mail/hooks'

// This is intentionally an identifier-only adapter until the worker's shared
// schema lands. It rejects every content-shaped field by selecting only the
// closed pointer vocabulary from otherwise untrusted message metadata.
const DoorwaySchema = z.object({
  accountId: z.string().min(1).max(200),
  draftId: z.string().min(1).max(500).optional(),
  mode: z.enum(['account', 'thread', 'compose']),
  source: z.enum(['gmail', 'mailbox']),
  threadId: z.string().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === 'thread' && !value.threadId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'A thread doorway needs a thread id.' })
})

export type MailSurfaceDoorway = z.infer<typeof DoorwaySchema>

export const readMailSurfaceDoorway = (metadata: Record<string, unknown> | undefined): MailSurfaceDoorway | null => {
  const parsed = DoorwaySchema.safeParse(metadata?.mailSurfaceDoorway)
  return parsed.success ? parsed.data : null
}

const doorwayPath = (doorway: MailSurfaceDoorway): string => {
  const root = mailPath(doorway)
  if (doorway.mode === 'thread' && doorway.threadId) return `${root}/threads/${encodeURIComponent(doorway.threadId)}`
  return doorway.mode === 'compose' ? `${root}/compose` : root
}

/** A conversation-local invite to live mail. It stores only its offered state
 * per identifier in sessionStorage; every actual open refetches accounts so a
 * revoked entitlement cannot retain a usable doorway. */
export const MailSurfaceDoorwayChip = ({ messageId, metadata }: {
  messageId: string
  metadata: Record<string, unknown> | undefined
}) => {
  const doorway = readMailSurfaceDoorway(metadata)
  const navigate = useNavigate()
  const accounts = useConnectedMailAccounts()
  const [open, setOpen] = useState(false)
  const ref = useMemo(() => ({ current: null as HTMLDivElement | null }), [])
  const storageKey = useMemo(() => doorway ? `mail-doorway-offered:${messageId}` : null, [doorway, messageId])
  const conversation = useConnectedMailConversation(
    doorway ? { accountId: doorway.accountId, source: doorway.source } : null,
    doorway?.threadId,
  )

  useEffect(() => {
    if (!storageKey || !ref.current) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      try {
        if (window.sessionStorage.getItem(storageKey) || window.sessionStorage.getItem('mail-doorway-overlay-open')) return
        window.sessionStorage.setItem(storageKey, 'offered')
        window.sessionStorage.setItem('mail-doorway-overlay-open', messageId)
        setOpen(true)
      } catch { /* The chip remains available when browser storage is unavailable. */ }
      observer.disconnect()
    }, { threshold: 0.5 })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [storageKey])

  if (!doorway) return null
  const entitled = accounts.data?.some((account) =>
    account.id === doorway.accountId && account.source === doorway.source && account.canRead,
  ) ?? false
  const title = doorway.mode === 'compose' ? 'Email draft ready' : doorway.mode === 'thread' ? 'Email ready to review' : 'Mail ready to review'
  const close = () => {
    try { window.sessionStorage.removeItem('mail-doorway-overlay-open') } catch { /* no-op */ }
    setOpen(false)
  }
  const openPreview = async () => {
    await accounts.refetch()
    setOpen(true)
  }
  const openMail = async () => {
    const refreshed = await accounts.refetch()
    const current = refreshed.data?.some((account) =>
      account.id === doorway.accountId && account.source === doorway.source && account.canRead,
    )
    if (!current) return
    close()
    navigate(doorwayPath(doorway))
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="mail-surface-doorway" ref={ref}>
      <span className="text-xs text-[color:var(--tx2)]">{title}</span>
      <button className="admin-button admin-button-secondary admin-button-compact" onClick={() => void openPreview()} type="button">Open mail</button>
      <Dialog description="Mail access is checked again before it opens." onClose={close} open={open} size="xl" title={title}>
        <div className="p-4">
          {accounts.isLoading ? <p className="text-sm text-[color:var(--tx2)]">Checking access…</p> : entitled ? <>{doorway.mode === 'thread' && conversation.data ? <ConnectedMailConversationView conversation={conversation.data} onReply={openMail} /> : <p className="text-sm text-[color:var(--tx2)]">Open the live mail surface to review this request.</p>}<button className="mt-3 admin-button admin-button-primary" onClick={() => void openMail()} type="button">Open mail</button></> : <p aria-live="polite" className="text-sm text-[color:var(--tx2)]">This email is no longer available to you.</p>}
        </div>
      </Dialog>
    </div>
  )
}
