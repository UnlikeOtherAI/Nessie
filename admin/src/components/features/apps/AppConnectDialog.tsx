import { useEffect, useId, useRef } from 'react'
import type { AppSummaryRecord } from '@nessie/schemas'

import { useAppConnectFlow } from '../../../facades/apps/connect-hooks'
import { useModalA11y } from '../../shared/useModalA11y'
import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { connectAuthExpectation, connectPublisherLine } from './app-connect-copy'
import { ConnectProgress } from './ConnectProgress'

/**
 * Connecting an app, without leaving the Apps page.
 *
 * The card's Connect button used to hand the person to the Connectors page's
 * install form — an endpoint URL and a key box over a page they had not asked
 * for. This dialog runs the same `useAppConnectFlow` the detail hero drives,
 * in place: the step list while probing, the provider's sign-in window for
 * OAuth, and the existing credentials path when the app wants a key. No raw
 * endpoint, no scope picker, no credential field ever renders here — the
 * caller's own scope is the only one this surface offers, and a key belongs
 * to the encrypted credential dialog on the Connectors page, which the
 * `needs_secret` panel points at.
 */

type AppConnectDialogProps = {
  app: AppSummaryRecord
  onClose: () => void
  open: boolean
}

export const AppConnectDialog = ({ app, onClose, open }: AppConnectDialogProps) => {
  const connect = useAppConnectFlow({ slug: app.slug ?? app.id })
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  // Closing mid-flow abandons it: the OAuth window is closed and the pending
  // marker forgotten, so the page does not resume a sign-in nobody is looking
  // at. Closing *after* a success keeps the result — the query is already
  // invalidated and the card flips to Connected on its own.
  const handleClose = () => {
    connect.dismiss()
    onClose()
  }

  useModalA11y(panelRef, handleClose, open)
  const overlayDismiss = useOverlayDismiss(handleClose)

  const { phase } = connect.state
  // Opening the dialog starts the flow: the probe answer is what decides
  // whether the sign-in sentence below says OAuth or key, and it is fast.
  // Reacting to `open` rather than mounting means the same dialog instance
  // can connect again without the card remounting it.
  useEffect(() => {
    if (open && phase === 'idle') {
      // The caller's own scope — connecting an app for yourself is what every
      // member may do without asking. A shared install stays an owner's
      // decision on the Connectors page, where the scope picker lives.
      connect.connect({ scopeType: 'user' })
    }
    // `connect.connect` is stable for the slug's lifetime; keying on the phase
    // restarts the flow only when it has returned to idle.
  }, [connect, open, phase])

  if (!open) return null

  // Both rules live in `app-connect-copy.ts` so they can be asserted.
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
    <div
      {...overlayDismiss}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--scrim-strong)] backdrop-blur-sm"
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="admin-card flex w-full max-w-md flex-col gap-4 p-5"
        data-testid="app-connect-dialog"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[color:var(--tx)]" id={titleId}>
              Connect {app.displayName}
            </h2>
            {publisher ? (
              <p className="mt-0.5 text-xs text-[color:var(--tx3)]" data-testid="app-connect-publisher">
                {publisher}
              </p>
            ) : null}
            <p className="mt-1 text-sm text-[color:var(--tx2)]" id={descriptionId}>
              {phase === 'connected'
                ? `${app.displayName} is connected. It is ready to use.`
                : phase === 'needs_secret'
                  ? `${app.displayName} needs an API key to finish connecting.`
                  : authExpectation}
            </p>
          </div>
          <button
            aria-label="Close"
            className={[
              'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded',
              'text-[color:var(--tx3)]',
              'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
            ].join(' ')}
            onClick={handleClose}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* The flow's own rendering: step list while probing, the waiting
            state for OAuth, friendly error copy with its technical-details
            disclosure, and the needs-a-key notice. Idle and connected render
            nothing — the header above carries the success sentence. */}
        <ConnectProgress
          appName={app.displayName}
          credentialsHref={`/mcp-app-store?catalogEntryId=${encodeURIComponent(app.id)}`}
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
    </div>
  )
}
