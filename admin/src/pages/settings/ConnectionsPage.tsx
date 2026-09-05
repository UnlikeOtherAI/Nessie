import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

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
import { EmptyState } from '../../components/shared/EmptyState'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from './settings-shared'
import { ConnectionCard } from './connections/ConnectionCard'
import { ModelSubscriptionSection } from './connections/ModelSubscriptionSection'
import { ProjectToolConnections } from './connections/ProjectToolConnections'
import { SendAuthorizationSection } from './connections/SendAuthorizationSection'

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

const SlackConnectButton = ({
  onConnect,
  pending,
}: {
  onConnect: () => void
  pending: boolean
}) => (
  <button
    className="admin-button admin-button-secondary admin-button-compact"
    disabled={pending}
    onClick={onConnect}
    type="button"
  >
    Connect Slack
  </button>
)

/**
 * Slack remains its own communications lane. Email is one user-facing surface:
 * Google/Microsoft use native sync while generic IMAP mail stays live and is
 * never imported, so one email doorway must not promise either behaviour for
 * every provider.
 */
export const ConnectionsPage = () => {
  const connections = useCommsConnections()
  const start = useStartCommsConnection()
  const [searchParams, setSearchParams] = useSearchParams()
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null)
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

  return (
    <SettingsPanel eyebrow="User" title="Connected accounts">
      <div className="flex flex-col gap-6">
        <p className="text-sm text-[color:var(--tx2)]">
          Connect Slack or email accounts for your Chief of Staff. Native Gmail and
          Microsoft accounts keep a private sync you can limit; other mailboxes stay live
          with their provider.
        </p>

        {callbackNotice ? (
          <p aria-live="polite" className="text-sm text-[color:var(--tx2)]">{callbackNotice}</p>
        ) : null}

        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-[color:var(--tx)]">Slack</h2>
              <p className="mt-1 text-sm text-[color:var(--tx2)]">
                Connect Slack separately from your email accounts.
              </p>
            </div>
            <SlackConnectButton onConnect={() => void connectSlack()} pending={start.isPending} />
          </div>
          <QueryState
            errorLabel="Could not load your Slack connections."
            loadingLabel="Loading Slack connections…"
            query={connections}
          >
            {() => slackConnections.length === 0 ? (
              <EmptyState title="No Slack account connected">
                Connect Slack to let your Chief of Staff work across your messages.
              </EmptyState>
            ) : (
              <div className="grid gap-4">
                {slackConnections.map((connection) => (
                  <ConnectionCard connection={connection} key={connection.id} />
                ))}
              </div>
            )}
          </QueryState>
        </section>

        <div className="h-px bg-[color:var(--bd1)]" />

        <section className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-[color:var(--tx)]">Email</h2>
              <p className="mt-1 text-sm text-[color:var(--tx2)]">
                Gmail and Microsoft sign in securely through their native APIs. Other
                providers connect live with secure IMAP and SMTP settings; native labels and
                folders can be limited after connecting.
              </p>
            </div>
            <MailboxConnectionForm scope="user" />
          </div>

          <QueryState
            errorLabel="Could not load synced email accounts."
            loadingLabel="Loading synced email accounts…"
            query={connections}
          >
            {() => (
              <>
                {emailConnections.length > 0 ? (
                  <div className="grid gap-4">
                    {emailConnections.map((connection) => (
                      <ConnectionCard connection={connection} key={connection.id} />
                    ))}
                  </div>
                ) : null}
                {emailConnections.length > 0 ? <SendAuthorizationSection /> : null}
              </>
            )}
          </QueryState>
          <MailboxConnectionsPanel embedded scope="user" showConnectAction={false} />
        </section>

        <div className="h-px bg-[color:var(--bd1)]" />
        <ProjectToolConnections />

        <div className="h-px bg-[color:var(--bd1)]" />
        <ModelSubscriptionSection />
      </div>
    </SettingsPanel>
  )
}
