import { useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { ConnectedMailMessage, ConnectedMailSource, ConnectedMailThreadSummary } from '@nessie/schemas'

import { ConnectedMailCompose } from '../components/features/connected-mail/ConnectedMailCompose'
import { ConnectedMailConversationView } from '../components/features/connected-mail/ConnectedMailConversation'
import { MailboxThreadList, MailboxWorkspace, type MailboxThreadSummary } from '../components/features/mailbox/MailboxWorkspace'
import { TabBar } from '../components/primitives/TabBar'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { mailPath, type MailAddress, useConnectedMailAccounts, useConnectedMailConversation, useConnectedMailThreads } from '../facades/mail/hooks'
import { useNavigationLayout } from '../lib/mobile-shell'

const sourceOf = (value: string | undefined): ConnectedMailSource | null =>
  value === 'gmail' || value === 'mailbox' ? value : null

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

const accountAddress = (source: ConnectedMailSource | null, accountId: string | undefined): MailAddress | null =>
  source && accountId ? { accountId, source } : null

export const ConnectedMailPage = () => {
  const { accountId, source: rawSource, threadId } = useParams<{
    accountId: string; source: string; threadId: string
  }>()
  const source = sourceOf(rawSource)
  const navigate = useNavigate()
  const routeLocation = useLocation()
  const layout = useNavigationLayout()
  const [searchParams, setSearchParams] = useSearchParams()
  const address = accountAddress(source, accountId)
  const accounts = useConnectedMailAccounts()
  const account = accounts.data?.find((item) => item.source === source && item.id === accountId)
  const isCompose = Boolean(address && routeLocation.pathname.endsWith('/compose'))
  const filter = searchParams.get('filter') === 'unread' ? 'unread' : 'all'
  const replyThreadId = searchParams.get('threadId') ?? undefined
  const replyMessageId = searchParams.get('reply') ?? undefined
  const pageSize = Number(searchParams.get('pageSize') ?? '25')
  const [searchDraft, setSearchDraft] = useState('')
  const [query, setQuery] = useState('')
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1)
  const threadQuery = useConnectedMailThreads(address, {
    cursor, pageSize: [10, 25, 50, 100].includes(pageSize) ? pageSize : 25,
    query, unreadOnly: filter === 'unread',
  })
  const conversation = useConnectedMailConversation(address, threadId ?? replyThreadId)
  const threads = threadQuery.data?.items ?? []
  const replyTo = conversation.data?.messages.find((message) => message.id === replyMessageId)

  if (!address) return <ConnectedMailAccounts />
  if (isCompose && account) return (
    <div className="flex h-full flex-col">
      <ScreenHeader backLabel="Back to mail" flowOwnsBack onBack={() => navigate(mailPath(address))} title="Compose email" />
      <ConnectedMailCompose
        account={account}
        address={address}
        onSent={() => navigate(mailPath(address))}
        replyTo={replyTo}
      />
    </div>
  )

  const setState = (next: Record<string, string | null>) => setSearchParams((current) => {
    const updated = new URLSearchParams(current)
    for (const [key, value] of Object.entries(next)) value ? updated.set(key, value) : updated.delete(key)
    return updated
  }, { replace: true })
  const headerActions: PageHeaderAction[] = account?.canCompose ? [{ id: 'new-email', label: 'New email', onSelect: () => navigate(`${mailPath(address)}/compose`), primary: true, priority: 1 }] : []
  const openThread = (id: string) => navigate(`${mailPath(address)}/threads/${encodeURIComponent(id)}${routeLocation.search}`)
  const reply = (message: ConnectedMailMessage) => navigate(
    `${mailPath(address)}/compose?threadId=${encodeURIComponent(message.threadId)}&reply=${encodeURIComponent(message.id)}`,
  )
  const list = (
    <aside className="flex min-h-0 flex-col gap-3 overflow-hidden">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setQuery(searchDraft); setCursors([]) }}>
        <input aria-label="Search mail" className="admin-input min-w-0 flex-1" onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search mail" value={searchDraft} />
        <button className="admin-button admin-button-secondary" type="submit">Search</button>
      </form>
      <TabBar ariaLabel="Mail filter" fullWidth items={[{ label: 'All', value: 'all' }, { label: 'Unread', value: 'unread' }]} onChange={(value) => setState({ filter: value === 'unread' ? 'unread' : null })} role="radiogroup" size="sm" value={filter} />
      <QueryState emptyLabel="No matching conversations." errorLabel="Could not load this mailbox." isEmpty={threads.length === 0} loadingLabel="Loading mail…" query={threadQuery}>
        {() => <MailboxThreadList ariaLabel="Mail conversations" onSelect={openThread} selectedId={threadId} threads={threads.map(asMailboxThread)} />}
      </QueryState>
      <MailPaging
        canPrevious={cursors.length > 0}
        next={() => {
          const next = threadQuery.data?.nextCursor
          if (next) setCursors((current) => [...current, next])
        }}
        page={threadQuery.data}
        previous={() => setCursors((current) => current.slice(0, -1))}
      />
    </aside>
  )

  const reader = (
    <QueryState emptyLabel="Select a conversation to read it." errorLabel="Could not load this conversation." isEmpty={!threadId || !conversation.data} loadingLabel="Loading conversation…" query={conversation}>
      {() => <ConnectedMailConversationView conversation={conversation.data!} onReply={reply} />}
    </QueryState>
  )
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader actions={headerActions} subtitle={account ? `${account.label} · ${account.address}` : 'Loading account…'} title="Mail" />
      {layout === 'single' && threadId ? reader : <MailboxWorkspace conversation={reader} conversationList={list} layout={layout} />}
    </div>
  )
}

const ConnectedMailAccounts = () => {
  const accounts = useConnectedMailAccounts()
  const navigate = useNavigate()
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Mail" />
      <QueryState emptyLabel="No connected email accounts are available to you." errorLabel="Could not load connected accounts." isEmpty={(accounts.data?.length ?? 0) === 0} loadingLabel="Loading connected accounts…" query={accounts}>
        {() => <ul className="divide-y divide-[color:var(--sep)] px-[var(--page-gutter)]">{accounts.data?.map((account) => <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={`${account.source}:${account.id}`}><div><p className="font-medium text-[color:var(--tx)]">{account.label}</p><p className="text-sm text-[color:var(--tx2)]">{account.address} · {account.scope} · {account.status}</p></div><button className="admin-button admin-button-secondary" disabled={!account.canRead} onClick={() => navigate(mailPath({ accountId: account.id, source: account.source }))} type="button">Open mail</button></li>)}</ul>}
      </QueryState>
    </div>
  )
}

const MailPaging = ({ canPrevious, next, page, previous }: {
  canPrevious: boolean
  next: () => void
  page: { estimate?: number; nextCursor?: string; previousCursor?: string } | undefined
  previous: () => void
}) => (
  <div className="flex items-center justify-between gap-2 text-xs text-[color:var(--tx3)]">
    <span>{page?.estimate !== undefined ? `About ${page.estimate} results` : 'Provider results'}</span>
    <span className="flex gap-2"><button className="admin-button admin-button-secondary admin-button-compact" disabled={!canPrevious} onClick={previous} type="button">Previous</button><button className="admin-button admin-button-secondary admin-button-compact" disabled={!page?.nextCursor} onClick={next} type="button">Next</button></span>
  </div>
)
