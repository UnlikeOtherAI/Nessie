import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { ConnectedMailAccountRecord, ConnectedMailMessage, ConnectedMailSource, ConnectedMailThreadSummary } from '@nessie/schemas'

import { ConnectedMailCompose } from '../components/features/connected-mail/ConnectedMailCompose'
import { ConnectedMailConversationView } from '../components/features/connected-mail/ConnectedMailConversation'
import { MailboxThreadList, MailboxWorkspace, type MailboxThreadSummary } from '../components/features/mailbox/MailboxWorkspace'
import { TabBar } from '../components/primitives/TabBar'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { mailPath, type MailAddress, useConnectedMailAccounts, useConnectedMailConversation, useConnectedMailThreads } from '../facades/mail/hooks'
import { connectedMailSettingsPath } from '../facades/mail/settings-path'
import { useNavigationLayout } from '../lib/mobile-shell'
import { useTabParam } from '../navigation/useTabParam'

const PAGE_SIZES = [10, 25, 50, 100] as const
const MAIL_FILTERS = ['all', 'unread'] as const

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

const errorCopy = (status: string | undefined): string => {
  if (status === 'needs_reauthorization') return 'This account needs reconnecting before mail can be read.'
  if (status === 'disabled') return 'Mail access is switched off for this account.'
  return 'This mailbox is unavailable. Check its connection and permissions.'
}

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
  const [filter, setFilter] = useTabParam('filter', MAIL_FILTERS, 'all')
  const replyThreadId = searchParams.get('threadId') ?? undefined
  const replyMessageId = searchParams.get('reply') ?? undefined
  const composeId = searchParams.get('compose') ?? undefined
  const newCompose = searchParams.get('new') === '1'
  const gmailDraftId = searchParams.get('draftId') ?? undefined
  const requestedPageSize = Number(searchParams.get('pageSize') ?? '25')
  const pageSize = PAGE_SIZES.includes(requestedPageSize as typeof PAGE_SIZES[number]) ? requestedPageSize : 25
  const accountIdentity = `${source ?? ''}:${accountId ?? ''}`
  const [searchState, setSearchState] = useState({ draft: '', identity: '', query: '' })
  // Search phrases are provider content, so they belong to this mounted mail
  // session only. The identity guard also ensures a prior account's phrase
  // cannot reach the next account during the route transition.
  const query = searchState.identity === accountIdentity ? searchState.query : ''
  const searchDraft = searchState.identity === accountIdentity ? searchState.draft : ''
  const listIdentity = `${source ?? ''}:${accountId ?? ''}:${filter}:${query}:${pageSize}`
  const [cursorState, setCursorState] = useState<{ identity: string; values: string[] }>({ identity: '', values: [] })
  const cursors = cursorState.identity === listIdentity ? cursorState.values : []
  const cursor = cursors.at(-1)
  useEffect(() => {
    setCursorState((current) => current.identity === listIdentity
      ? current
      : { identity: listIdentity, values: [] })
  }, [listIdentity])
  const completeNewCompose = useCallback(() => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('new')
      return next
    }, { replace: true })
  }, [setSearchParams])
  const entitledAddress = account?.canRead ? address : null
  const threadQuery = useConnectedMailThreads(entitledAddress, {
    cursor, pageSize, query, unreadOnly: filter === 'unread',
  })
  const conversation = useConnectedMailConversation(entitledAddress, threadId ?? replyThreadId)
  const threads = threadQuery.data?.items ?? []
  const replyTo = conversation.data?.messages.find((message) => message.id === replyMessageId)

  const setState = (next: Record<string, string | null>) => setSearchParams((current) => {
    const updated = new URLSearchParams(current)
    for (const [key, value] of Object.entries(next)) value ? updated.set(key, value) : updated.delete(key)
    return updated
  }, { replace: true })
  const setCursors = (update: (current: string[]) => string[]) => setCursorState((current) => ({
    identity: listIdentity,
    values: update(current.identity === listIdentity ? current.values : []),
  }))
  const updateSearchDraft = (draft: string) => setSearchState((current) => ({
    draft,
    identity: accountIdentity,
    query: current.identity === accountIdentity ? current.query : '',
  }))
  const applySearch = () => setSearchState((current) => {
    const draft = current.identity === accountIdentity ? current.draft : ''
    return { draft, identity: accountIdentity, query: draft }
  })

  if (!address) return <ConnectedMailAccounts />
  if (isCompose && account && !account.canCompose) return (
    <div className="flex h-full flex-col">
      <ScreenHeader backLabel="Back to mail" flowOwnsBack onBack={() => navigate(mailPath(address))} title="Compose email" />
      <MailUnavailable account={account} message="Drafting email is not available for this account." />
    </div>
  )
  if (isCompose && account) return (
    <div className="flex h-full flex-col">
      <ScreenHeader backLabel="Back to mail" flowOwnsBack onBack={() => navigate(mailPath(address))} title="Compose email" />
      <ConnectedMailCompose
        account={account}
        address={address}
        composeId={composeId}
        gmailDraftId={gmailDraftId}
        newCompose={newCompose}
        onNewComposeReady={completeNewCompose}
        key={`${composeId ?? 'default'}:${gmailDraftId ?? replyMessageId ?? 'new'}`}
        onOpenSettings={() => navigate(connectedMailSettingsPath(account))}
        onSent={() => navigate(mailPath(address))}
        onStartNewEmail={(id) => navigate(`${mailPath(address)}/compose?compose=${id}&new=1`)}
        replyTo={replyTo}
      />
    </div>
  )

  const unavailable = account && !account.canRead
  const headerActions: PageHeaderAction[] = [
    ...(account?.canCompose ? [{ id: 'new-email', label: 'New email', onSelect: () => navigate(`${mailPath(address)}/compose`), primary: true, priority: 1 }] : []),
    { id: 'refresh-mail', label: 'Refresh', onSelect: () => { void accounts.refetch(); void threadQuery.refetch() }, priority: 2 },
  ]
  const openThread = (id: string) => navigate(`${mailPath(address)}/threads/${encodeURIComponent(id)}${routeLocation.search}`)
  const reply = (message: ConnectedMailMessage) => navigate(
    `${mailPath(address)}/compose?threadId=${encodeURIComponent(message.threadId)}&reply=${encodeURIComponent(message.id)}`,
  )
  const selectAccount = (value: string) => {
    const next = accounts.data?.find((item) => `${item.source}:${item.id}` === value)
    if (!next) return
    navigate({ pathname: mailPath({ accountId: next.id, source: next.source }), search: searchParams.toString() })
  }
  const list = (
    <aside className="flex min-h-0 flex-col gap-3 overflow-hidden" data-testid="connected-mail-thread-list">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-48 flex-1 gap-1 text-xs text-[color:var(--tx2)]">Account
          <select aria-label="Mail account" className="admin-input" onChange={(event) => selectAccount(event.target.value)} value={`${source}:${accountId}`}>
            {(accounts.data ?? []).filter((item) => item.canRead).map((item) => <option key={`${item.source}:${item.id}`} value={`${item.source}:${item.id}`}>{item.label} · {item.address}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-[color:var(--tx2)]">Items per page
          <select aria-label="Items per page" className="admin-input" onChange={(event) => setState({ pageSize: event.target.value === '25' ? null : event.target.value })} value={String(pageSize)}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); applySearch() }}>
        <input aria-label="Search mail" className="admin-input min-w-0 flex-1" onChange={(event) => updateSearchDraft(event.target.value)} placeholder="Search mail" value={searchDraft} />
        <button className="admin-button admin-button-secondary" type="submit">Search</button>
      </form>
      <TabBar ariaLabel="Mail filter" fullWidth items={[{ label: 'All', value: 'all' }, { label: 'Unread', value: 'unread' }]} onChange={setFilter} role="radiogroup" size="sm" value={filter} />
      <QueryState emptyLabel="No matching conversations." errorLabel="Could not load this mailbox. Check its settings, then refresh." isEmpty={threads.length === 0} loadingLabel="Loading mail…" query={threadQuery}>
        {() => <MailboxThreadList ariaLabel="Mail conversations" onSelect={openThread} selectedId={threadId} threads={threads.map(asMailboxThread)} />}
      </QueryState>
      {threadQuery.isError && account ? <button className="self-start text-xs font-semibold text-[color:var(--accent)]" onClick={() => navigate(connectedMailSettingsPath(account))} type="button">Check mailbox settings</button> : null}
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
      <ScreenHeader
        actions={headerActions}
        backLabel="Back to mail"
        flowOwnsBack={layout === 'single' && Boolean(threadId)}
        onBack={layout === 'single' && threadId ? () => navigate(`${mailPath(address)}${routeLocation.search}`) : undefined}
        subtitle={account
          ? `${account.label} · ${account.address}`
          : accounts.isLoading ? 'Loading account…' : 'Account unavailable'}
        title="Mail"
      />
      {/* Pending is never empty, and an id that resolves to nothing is never a
          working workspace: until the account list settles the thread query is
          disabled, so the list would otherwise read "No matching conversations"
          on every cold load, and an unknown or foreign id would render the full
          mail surface under a subtitle that loaded forever. */}
      {accounts.isLoading
        ? <section className="px-[var(--page-gutter)] py-6"><p className="text-sm text-[color:var(--tx2)]">Loading connected accounts…</p></section>
        : accounts.isError && !account
          ? <MailAccountsUnreachable onRetry={() => void accounts.refetch()} />
          : !account
            ? <MailAccountMissing />
            : unavailable
              ? <MailUnavailable account={account} />
              : layout === 'single' && threadId
                ? reader
                : <MailboxWorkspace conversation={reader} conversationList={list} layout={layout} />}
    </div>
  )
}

/** A transport failure is not an entitlement answer: saying "not available to
 *  you" for a dropped request would misreport why the surface is empty. */
const MailAccountsUnreachable = ({ onRetry }: { onRetry: () => void }) => (
  <section className="px-[var(--page-gutter)] py-6">
    <p className="text-sm text-[color:var(--tx2)]">Could not load your connected accounts.</p>
    <button className="mt-3 admin-button admin-button-secondary" onClick={onRetry} type="button">Try again</button>
  </section>
)

/** An account this viewer is not entitled to reads the same as one that never
 *  existed, so the surface says neither which it was. */
const MailAccountMissing = () => {
  const navigate = useNavigate()
  return (
    <section className="px-[var(--page-gutter)] py-6">
      <p className="text-sm text-[color:var(--tx2)]">This mail account is not available to you.</p>
      <button className="mt-3 admin-button admin-button-secondary" onClick={() => navigate('/mail')} type="button">Choose an account</button>
    </section>
  )
}

const MailUnavailable = ({ account, message }: {
  account: { id: string; scope: 'personal' | 'shared'; source: ConnectedMailSource; status: string }
  message?: string
}) => {
  const navigate = useNavigate()
  return <section className="px-[var(--page-gutter)] py-6"><p className="text-sm text-[color:var(--tx2)]">{message ?? errorCopy(account.status)}</p><button className="mt-3 admin-button admin-button-secondary" onClick={() => navigate(connectedMailSettingsPath(account))} type="button">Open mailbox settings</button></section>
}

const ConnectedMailAccounts = () => {
  const accounts = useConnectedMailAccounts()
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Mail" />
      <QueryState emptyLabel="No connected email accounts are available to you." errorLabel="Could not load connected accounts." isEmpty={(accounts.data?.length ?? 0) === 0} loadingLabel="Loading connected accounts…" query={accounts}>
        {() => <ul className="divide-y divide-[color:var(--sep)] px-[var(--page-gutter)]">{accounts.data?.map((account) => <ConnectedMailAccountRow account={account} key={`${account.source}:${account.id}`} />)}</ul>}
      </QueryState>
    </div>
  )
}

const ConnectedMailAccountRow = ({ account }: { account: ConnectedMailAccountRecord }) => {
  const navigate = useNavigate()
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div><p className="font-medium text-[color:var(--tx)]">{account.label}</p><p className="text-sm text-[color:var(--tx2)]">{account.address} · {account.scope} · {account.status}</p>{!account.canRead ? <p className="mt-1 text-sm text-[color:var(--tx2)]">{errorCopy(account.status)}</p> : null}</div>
      {account.canRead ? <button className="admin-button admin-button-secondary" onClick={() => navigate(mailPath({ accountId: account.id, source: account.source }))} type="button">Open mail</button> : <button className="admin-button admin-button-secondary" onClick={() => navigate(connectedMailSettingsPath(account))} type="button">Open mailbox settings</button>}
    </li>
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
