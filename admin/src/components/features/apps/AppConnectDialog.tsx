import { useRef, useState } from 'react'
import type { AppSummaryRecord } from '@nessie/schemas'

import { useAppConnectFlow } from '../../../facades/apps/connect-hooks'
import { Dialog } from '../../shared/Dialog'
import {
  connectAuthExpectation,
  connectAuthType,
  connectPublisherLine,
} from './app-connect-copy'
import { AppSecretDialog } from './AppSecretDialog'
import { ConnectProgress } from './ConnectProgress'

/**
 * Connecting an app, without leaving the Apps page.
 *
 * The person reviews its authentication and audience first, then confirmation
 * starts `useAppConnectFlow`: the step list while probing, the provider's
 * sign-in window, and the app-owned encrypted key dialog when needed. No raw
 * endpoint or scope picker renders here — the caller's own scope is the only
 * one this surface offers.
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

  // Closing mid-flow abandons it: the OAuth window is closed and the pending
  // marker forgotten, so the page does not resume a sign-in nobody is looking
  // at. Closing *after* a success keeps the result — the query is already
  // invalidated and the card flips to Connected on its own.
  const handleClose = () => {
    connect.dismiss()
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
            <dl className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--sep)] bg-[color:var(--panel-soft)] p-3 text-sm">
              <div className="grid gap-0.5">
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-[color:var(--tx3)]">
                  Authentication
                </dt>
                <dd className="font-medium text-[color:var(--tx)]">{connectAuthType(app)}</dd>
                <dd className="text-[color:var(--tx2)]">{expectationFromCatalogue}</dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-[color:var(--tx3)]">
                  Who can use it
                </dt>
                <dd className="text-[color:var(--tx2)]">
                  Just you. You can choose which agents may use it after it connects.
                </dd>
              </div>
            </dl>
            <div className="flex justify-end gap-2">
              <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                data-testid="app-connect-confirm"
                onClick={() => connect.connect({ scopeType: 'user' })}
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
        connectionId={secretConnectionId}
        onClose={() => setSecretConnectionId(null)}
        onSaved={() => {
          connect.retry()
        }}
      />
    </>
  )
}
