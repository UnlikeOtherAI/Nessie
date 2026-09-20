import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  useCommsConnections,
  useStartCommsConnection,
} from '../../facades/connections/hooks'
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
import { ConnectionsTable } from './connections/ConnectionsTable'
import { GoogleWorkspaceConnectDialog } from './connections/GoogleWorkspaceConnectDialog'
import { ModelSubscriptionSection } from './connections/ModelSubscriptionSection'
import { LocalOllamaSection } from './connections/LocalOllamaSection'
import { ProjectToolConnections } from './connections/ProjectToolConnections'
import { SendAuthorizationSection } from './connections/SendAuthorizationSection'

const accountsListStore = createListPageStore()

const callbackErrorCopy: Record<string, string> = {
  access_denied: 'Connection was not completed.',
  account_mismatch: 'The account you chose does not match the connection you started.',
  connect_failed: 'Your email provider could not complete the connection. Try again.',
  connector_unavailable: 'This email provider is not available in this deployment.',
  invalid_callback: 'Connection was not completed. Try again.',
  provider_access_blocked: 'Your organisation does not currently allow this app to access email.',
  reauthorization_required: 'Your email provider needs you to sign in again.',
  state_invalid: 'That connection link has expired. Start again to continue.',
}

const callbackMessage = (connected: string | null, error: string | null): string | null => {
  if (connected) return connected === 'slack' ? 'Slack connected.' : 'Email connected.'
  return error ? callbackErrorCopy[error] ?? 'Connection was not completed. Try again.' : null
}

/**
 * Connected accounts — one screen, five lanes.
 *
 * It was five stacked sections separated by hairlines, so the model provider a
 * person came to change sat four scroll-lengths below a Slack panel they were
 * not looking for. The sections are tabs in the one header now, in the order
 * they are actually used: the mailboxes first, the inference provider second.
 *
 * Slack remains its own communications lane. Email is one user-facing surface:
 * Google/Microsoft use native sync while generic IMAP mail stays live and is
 * never imported, so one email doorway must not promise either behaviour for
 * every provider.
 */
const CONNECTION_TABS = ['email', 'inference', 'slack', 'calendar', 'tools'] as const
type ConnectionTab = (typeof CONNECTION_TABS)[number]

const TAB_META: Record<ConnectionTab, { description: string; label: string }> = {
  calendar: {
    description:
      'Connect Calendar or Meet without granting Gmail access. Choose each permission before '
      + 'Google asks you to sign in.',
    label: 'Calendar & Meet',
  },
  email: {
    description:
      'Gmail and Microsoft sign in securely through their native APIs. Other providers connect '
      + 'live with secure IMAP and SMTP settings; native labels and folders can be limited after '
      + 'connecting.',
    label: 'Email',
  },
  inference: {
    description:
      'Which model provider answers for you, and the subscription it bills against.',
    label: 'AI inference provider',
  },
  slack: {
    description: 'Connect Slack separately from your email accounts.',
    label: 'Slack',
  },
  tools: {
    description: 'Accounts a project’s tools sign in with, shared by the work in that project.',
    label: 'Project tools',
  },
}

export const ConnectionsPage = () => {
  const navigate = useNavigate()
  const connections = useCommsConnections()
  const start = useStartCommsConnection()
  const [searchParams, setSearchParams] = useSearchParams()
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null)
  const [googleWorkspaceOpen, setGoogleWorkspaceOpen] = useState(false)
  const [tab, setTab] = useTabParam('tab', CONNECTION_TABS, 'email')

  const connected = searchParams.get('connected')
  const callbackError = searchParams.get('error')
  const rows = connections.data?.connections ?? []
  const slackConnections = rows.filter((connection) => connection.provider === 'slack')
  const emailConnections = rows.filter((connection) => connection.provider !== 'slack')

  useEffect(() => {
    const message = callbackMessage(connected, callbackError)
    if (!message) return
    setCallbackNotice(message)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('connected')
      next.delete('error')
      next.delete('provider')
      return next
    }, { replace: true })
  }, [callbackError, connected, setSearchParams])

  const connectSlack = async () => {
    try {
      const result = await start.mutateAsync('slack')
      window.location.assign(result.authorizeUrl)
    } catch {
      setCallbackNotice('Slack could not start the connection. Try again.')
    }
  }

  // Only the two account lanes are lists, so only they page.
  const accountRows = tab === 'slack' ? slackConnections : emailConnections
  const paged = tab === 'slack' || tab === 'email'

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

  // Each lane brings its own way in, so the header's action is the one that
  // belongs to what is on screen rather than a row of five connect buttons.
  const actions: PageHeaderAction[] = tab === 'slack'
    ? [{
      disabled: start.isPending,
      id: 'connect-slack',
      label: 'Connect Slack',
      onSelect: () => void connectSlack(),
      primary: true,
      priority: 100,
    }]
    : tab === 'calendar'
      ? [{
        id: 'connect-google-workspace',
        label: 'Connect Calendar or Meet',
        onSelect: () => setGoogleWorkspaceOpen(true),
        primary: true,
        priority: 100,
      }]
      : tab === 'email'
        ? [{
          id: 'connect-mailbox',
          kind: 'custom',
          label: 'Connect mailbox',
          pinned: true,
          priority: 100,
          render: () => <MailboxConnectionForm scope="user" />,
        }]
        : []

  const openConnection = (connectionId: string) =>
    void navigate(`/settings/connections/${connectionId}`)

  return (
    <SettingsPanel
      actions={actions}
      eyebrow="User"
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
        <p className="max-w-3xl text-sm text-[color:var(--tx3)]">{TAB_META[tab].description}</p>
      }
      tabs={
        <TabBar
          ariaLabel="Connected account sections"
          items={CONNECTION_TABS.map((value) => ({ label: TAB_META[value].label, value }))}
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
        {callbackNotice ? (
          <p aria-live="polite" className="text-sm text-[color:var(--tx2)]">{callbackNotice}</p>
        ) : null}

        {tab === 'email' ? (
          <>
            <QueryState
              errorLabel="Could not load synced email accounts."
              loadingLabel="Loading synced email accounts…"
              query={connections}
            >
              {() => (
                <ConnectionsTable
                  connections={pageRows}
                  emptyMessage="No email account connected yet."
                  isLoading={false}
                  onOpen={openConnection}
                />
              )}
            </QueryState>
            {emailConnections.length > 0 ? <SendAuthorizationSection /> : null}
            <MailboxConnectionsPanel embedded scope="user" showConnectAction={false} />
          </>
        ) : null}

        {tab === 'inference' ? <><ModelSubscriptionSection /><LocalOllamaSection /></> : null}

        {tab === 'slack' ? (
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

        {tab === 'calendar' ? (
          <p className="max-w-3xl text-sm text-[color:var(--tx2)]">
            Calendar and Meet are granted per permission. Connecting one does not give Nessie
            access to your mail.
          </p>
        ) : null}

        {tab === 'tools' ? <ProjectToolConnections /> : null}

        <GoogleWorkspaceConnectDialog
          onClose={() => setGoogleWorkspaceOpen(false)}
          open={googleWorkspaceOpen}
        />
      </div>
    </SettingsPanel>
  )
}
