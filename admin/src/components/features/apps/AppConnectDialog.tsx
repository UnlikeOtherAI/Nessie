import { useRef, useState } from 'react'
import type { AppSummaryRecord } from '@nessie/schemas'

import { useAppConnectFlow } from '../../../facades/apps/connect-hooks'
import { useChannels } from '../../../facades/channels/hooks'
import { TabBar } from '../../primitives/TabBar'
import { Dialog } from '../../shared/Dialog'
import { KeyValueList } from '../../shared/KeyValueList'
import {
  connectAuthExpectation,
  connectAuthType,
  connectPublisherLine,
} from './app-connect-copy'
import {
  appConnectScopeCopy,
  buildAppConnectScope,
  canShareAppConnectionKey,
  type AppConnectScopeChoice,
} from './app-connect-scope'
import { AppSecretDialog } from './AppSecretDialog'
import { ConnectProgress } from './ConnectProgress'

/**
 * Connecting an app, without leaving the Apps page.
 *
 * The person reviews its authentication and audience first, then confirmation
 * starts `useAppConnectFlow`: the step list while probing, the provider's
 * sign-in window, and the app-owned encrypted key dialog when needed. Personal
 * scope is the default; a person may deliberately bind a separate connection
 * to one channel they can access.
 */

type AppConnectDialogProps = {
  app: AppSummaryRecord
  onClose: () => void
  open: boolean
}

export const AppConnectDialog = ({ app, onClose, open }: AppConnectDialogProps) => {
  const connect = useAppConnectFlow({ slug: app.slug ?? app.id })
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [secretConnectionId, setSecretConnectionId] = useState<string | null>(null)
  const [scopeChoice, setScopeChoice] = useState<AppConnectScopeChoice>('user')
  const [channelId, setChannelId] = useState('')
  const channels = useChannels({ enabled: open && scopeChoice === 'channel' })
  const selectedChannel = channels.data?.find((channel) => channel.id === channelId)
  const scope = buildAppConnectScope(scopeChoice, channelId)

  // Closing mid-flow abandons it: the OAuth window is closed and the pending
  // marker forgotten, so the page does not resume a sign-in nobody is looking
  // at. Closing *after* a success keeps the result — the query is already
  // invalidated and the card flips to Connected on its own.
  const handleClose = () => {
    connect.dismiss()
    setScopeChoice('user')
    setChannelId('')
    setSecretConnectionId(null)
    onClose()
  }

  const { phase } = connect.state
  const publisher = connectPublisherLine(app)
  const expectationFromCatalogue = connectAuthExpectation(app)
  const authExpectation =
    phase === 'awaiting_authorization' || connect.state.requiresAuthorization
      ? `You will be asked to sign in with ${app.displayName}.`
      : phase === 'needs_secret'
        ? null // ConnectProgress says this in full, with the way to the key.
        : phase === 'connected' && !connect.state.requiresAuthorization
          ? 'No sign-in was needed.'
          : expectationFromCatalogue

  return (
    <>
      <Dialog
        description={publisher ?? undefined}
        dismissDisabled={phase === 'probing' || phase === 'verifying'}
        initialFocusRef={phase === 'idle' ? confirmRef : undefined}
        onClose={handleClose}
        open={open}
        title={
          phase === 'idle' ? `Review connection to ${app.displayName}` : `Connect ${app.displayName}`
        }
      >
        {phase === 'idle' ? (
          <div className="grid gap-4" data-testid="app-connect-review">
            <p className="text-sm text-[color:var(--tx2)]">
              Review how this app connects before Nessie creates an account for it.
            </p>
            <div className="rounded-[var(--radius-md)] border border-[color:var(--sep)] bg-[color:var(--panel-soft)] p-3">
              <KeyValueList
                items={[
                  {
                    label: 'Authentication',
                    value: (
                      <span className="grid gap-0.5">
                        <span className="font-medium text-[color:var(--tx)]">{connectAuthType(app)}</span>
                        <span className="text-[color:var(--tx2)]">{expectationFromCatalogue}</span>
                      </span>
                    ),
                  },
                  {
                    label: 'Who can use it',
                    value: (
                      <span className="grid gap-3 text-[color:var(--tx2)]">
                        <TabBar
                          ariaLabel="Choose who this app connection is for"
                          items={[
                            { label: 'Just you', testId: 'app-connect-scope-user', value: 'user' },
                            { label: 'A channel', testId: 'app-connect-scope-channel', value: 'channel' },
                          ]}
                          onChange={setScopeChoice}
                          role="radiogroup"
                          size="sm"
                          value={scopeChoice}
                        />
                        {scopeChoice === 'channel' ? (
                          <label className="grid gap-1.5 text-sm font-medium text-[color:var(--tx)]" htmlFor="app-connect-channel">
                            Channel
                            <select
                              aria-describedby="app-connect-channel-scope-copy"
                              className="admin-input"
                              data-testid="app-connect-channel-picker"
                              disabled={channels.isPending || channels.isError}
                              id="app-connect-channel"
                              onChange={(event) => setChannelId(event.target.value)}
                              value={channelId}
                            >
                              <option value="">
                                {channels.isPending
                                  ? 'Loading channels…'
                                  : channels.isError
                                    ? 'Channels could not be loaded'
                                    : 'Choose a channel'}
                              </option>
                              {(channels.data ?? []).map((channel) => (
                                <option key={channel.id} value={channel.id}>
                                  {channel.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        <span data-testid="app-connect-scope-copy" id="app-connect-channel-scope-copy">
                          {appConnectScopeCopy(scopeChoice, selectedChannel?.label)}
                        </span>
                      </span>
                    ),
                  },
                ]}
                layout="grid"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                data-testid="app-connect-confirm"
                disabled={!scope}
                onClick={() => {
                  if (scope) connect.connect(scope)
                }}
                ref={confirmRef}
                type="button"
              >
                Connect {app.displayName}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <p className="text-sm text-[color:var(--tx2)]">
              {phase === 'connected'
                ? `${app.displayName} is connected. It is ready to use.`
                : phase === 'needs_secret'
                  ? `${app.displayName} needs an API key to finish connecting.`
                  : authExpectation}
            </p>
            <ConnectProgress
              appName={app.displayName}
              onAddSecret={setSecretConnectionId}
              onDismiss={connect.dismiss}
              onReopenAuthorization={connect.reopenAuthorization}
              onRetry={connect.retry}
              state={connect.state}
            />
            {phase === 'connected' ? (
              <div className="flex justify-end">
                <button
                  className="admin-button admin-button-primary admin-button-compact"
                  onClick={handleClose}
                  type="button"
                >
                  Done
                </button>
              </div>
            ) : null}
          </div>
        )}
      </Dialog>
      <AppSecretDialog
        canShare={canShareAppConnectionKey(app.authMethod, scopeChoice)}
        connectionId={secretConnectionId}
        onClose={() => setSecretConnectionId(null)}
        onSaved={() => {
          connect.retry()
        }}
      />
    </>
  )
}
