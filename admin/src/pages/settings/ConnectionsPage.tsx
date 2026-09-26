import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  useCommsConnections,
  useStartCommsConnection,
} from '../../facades/connections/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { MyBrowserLoginsPanel } from '../../components/features/browser-cloud/MyBrowserLoginsPanel'
import {
  MailboxConnectionForm,
} from '../../components/features/mailbox-connections/MailboxConnectionForm'
import {
  MailboxConnectionsPanel,
} from '../../components/features/mailbox-connections/MailboxConnectionsPanel'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { createListPageStore } from '../../components/shared/list-page-state'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { TabBar } from '../../components/primitives/TabBar'
import { useTabParam } from '../../navigation/useTabParam'
import {
  CONNECTION_TABS,
  CONNECTION_TAB_META,
  DEFAULT_CONNECTION_TAB,
  PROVIDER_TAB,
} from './connections/connection-tabs'
import { ConnectionsTable } from './connections/ConnectionsTable'
import { GoogleWorkspaceConnectDialog } from './connections/GoogleWorkspaceConnectDialog'
import { ModelSubscriptionSection } from './connections/ModelSubscriptionSection'
import { LocalOllamaSection } from './connections/LocalOllamaSection'
import { ProjectToolConnections } from './connections/ProjectToolConnections'
import { SendAuthorizationSection } from './connections/SendAuthorizationSection'
import { useConnectionLanding } from './connections/useConnectionLanding'

const accountsListStore = createListPageStore()

/**
 * Connected accounts — one screen, five tabs grouped by what an account is for
 * (`connections/connection-tabs.ts`).
 *
 * It was five stacked sections separated by hairlines, so the model provider a
 * person came to change sat four scroll-lengths below a Slack panel they were
 * not looking for. The sections are tabs in the one header now, mail first.
 *
 * Mail and calendar is one surface for every mail account and a Google
 * account's calendar. Google and Microsoft sync natively while other mail
 * stays live and is never imported, so the one email doorway must not promise
 * either behaviour for every provider; Calendar or Meet connects without mail,
 * and the account it makes is listed in the same table as the mail accounts,
 * where its page shows every capability it holds. Chat is Slack, its own
 * communications lane.
 *
 * Browsers is the cloud browser your agents borrow for the runs you start, and
 * the sign-ins you gave them there. Your sign-ins list stands on its own: it is
 * keyed by what you did, not by whether you still have an account of your own
 * connected.
 *
 * AI plans holds the subscriptions the agents you own run on, and the local
 * models on your own computer, present whether or not a computer is paired.
 */
export const ConnectionsPage = () => {
  const navigate = useNavigate()
  const { me } = useAuthSession()
  const connections = useCommsConnections()
  const start = useStartCommsConnection()
  const [googleWorkspaceOpen, setGoogleWorkspaceOpen] = useState(false)
  const [tab, setTab] = useTabParam('tab', CONNECTION_TABS, DEFAULT_CONNECTION_TAB)
  const { notice, showNotice } = useConnectionLanding(tab, setTab)

  const rows = connections.data?.connections ?? []
  const chatConnections = rows.filter((connection) => PROVIDER_TAB[connection.provider] === 'chat')
  const mailConnections = rows.filter((connection) => PROVIDER_TAB[connection.provider] === 'mail')

  const connectSlack = async () => {
    try {
      const result = await start.mutateAsync('slack')
      window.location.assign(result.authorizeUrl)
    } catch {
      showNotice({ message: 'Slack could not start the connection. Try again.', tab: 'chat' })
    }
  }

  // Only the two synced-account lanes are lists, so only they page.
  const accountRows = tab === 'chat' ? chatConnections : mailConnections
  const paged = tab === 'chat' || tab === 'mail'

  const [initialState] = useState(accountsListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  const totalPages = Math.max(1, Math.ceil(accountRows.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageRows = accountRows.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = accountRows.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, accountRows.length)

  useEffect(() => {
    accountsListStore.save({ page, pageSize })
  }, [page, pageSize])

  // Each lane brings its own way in, so the header's actions are the ones that
  // belong to what is on screen rather than a row of every connect button.
  // Mail and calendar has two ways in — a mailbox, or Calendar or Meet without
  // mail — and neither outranks the other, so neither is the filled one.
  const actions: PageHeaderAction[] = tab === 'chat'
    ? [{
      disabled: start.isPending,
      id: 'connect-slack',
      label: 'Connect Slack',
      onSelect: () => void connectSlack(),
      primary: true,
      priority: 100,
    }]
    : tab === 'mail'
      ? [
        {
          id: 'connect-mailbox',
          kind: 'custom',
          label: 'Connect mailbox',
          pinned: true,
          priority: 100,
          render: () => <MailboxConnectionForm scope="user" />,
        },
        {
          id: 'connect-google-workspace',
          label: 'Connect Calendar or Meet',
          onSelect: () => setGoogleWorkspaceOpen(true),
          priority: 90,
        },
      ]
      : []

  const openConnection = (connectionId: string) =>
    void navigate(`/settings/accounts/${connectionId}`)

  return (
    <SettingsPanel
      actions={actions}
      eyebrow="Your settings"
      footer={paged ? (
        <PaginationFooter
          canNext={page < totalPages - 1}
          canPrevious={page > 0}
          label={
            accountRows.length === 0
              ? 'No accounts'
              : `${rangeStart}–${rangeEnd} of ${accountRows.length}`
          }
          onPageChange={setRequestedPage}
          onPageSizeChange={(next) => {
            setPageSize(next)
            setRequestedPage(0)
          }}
          page={page}
          pageCount={totalPages}
          pageSize={pageSize}
        />
      ) : null}
      subtitle={
        <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
          {CONNECTION_TAB_META[tab].description}
        </p>
      }
      tabs={
        <TabBar
          ariaLabel="Connected account sections"
          items={CONNECTION_TABS.map((value) => ({ label: CONNECTION_TAB_META[value].label, value }))}
          onChange={(next) => {
            setTab(next)
            setRequestedPage(0)
          }}
          value={tab}
        />
      }
      title="Connected accounts"
    >
      <div className="flex flex-col gap-4">
        {notice && (notice.tab === null || notice.tab === tab) ? (
          <p aria-live="polite" className="text-sm text-[color:var(--tx2)]">{notice.message}</p>
        ) : null}

        {tab === 'mail' ? (
          <>
            <QueryState
              errorLabel="Could not load synced email accounts."
              loadingLabel="Loading synced email accounts…"
              query={connections}
            >
              {() => (
                <ConnectionsTable
                  connections={pageRows}
                  emptyMessage="No mail or calendar account connected yet."
                  isLoading={false}
                  onOpen={openConnection}
                />
              )}
            </QueryState>
            <p className="max-w-3xl text-sm text-[color:var(--tx2)]">
              Calendar and Meet are granted per permission. Connecting one does not give Nessie
              access to your mail.
            </p>
            {mailConnections.length > 0 ? <SendAuthorizationSection /> : null}
            <MailboxConnectionsPanel embedded scope="user" showConnectAction={false} />
          </>
        ) : null}

        {tab === 'chat' ? (
          <QueryState
            errorLabel="Could not load your Slack connections."
            loadingLabel="Loading Slack connections…"
            query={connections}
          >
            {() => (
              <ConnectionsTable
                connections={pageRows}
                emptyMessage="No Slack account connected. Connect Slack to let your Chief of Staff work across your messages."
                isLoading={false}
                onOpen={openConnection}
              />
            )}
          </QueryState>
        ) : null}

        {tab === 'tickets' ? <ProjectToolConnections /> : null}

        {/* The session's team is passed down so a lock set by the team — not
            only one set by the organisation — greys the control and says so. */}
        {tab === 'browsers' ? (
          <>
            <CloudBrowserPanel scope="user" teamId={me?.context.teamId ?? null} />
            <MyBrowserLoginsPanel />
          </>
        ) : null}

        {tab === 'ai' ? <><ModelSubscriptionSection /><LocalOllamaSection /></> : null}

        <GoogleWorkspaceConnectDialog
          onClose={() => setGoogleWorkspaceOpen(false)}
          open={googleWorkspaceOpen}
        />
      </div>
    </SettingsPanel>
  )
}
