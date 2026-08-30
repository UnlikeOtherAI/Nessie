import { Link } from 'react-router-dom'
import { connectErrorPresentation } from './connect-error-copy'
import {
  connectShowsSlowProviderNote,
  connectSteps,
  type ConnectState,
  type ConnectStep,
} from './connect-flow'

/**
 * What connecting looks like while it happens.
 *
 * Inline under the hero CTA — never a toast, never a modal — because the person
 * is deciding about *this* app and the page they are reading is the context. A
 * bare spinner is never shown: a connect can take a provider round trip, and a
 * step list is the difference between "it is working" and "it has hung".
 *
 * Nothing here can render a credential. The only server-authored strings it
 * shows are the normalized error code and its message, and those sit inside a
 * closed disclosure; the authorization URL appears solely as the `href` of the
 * link a person clicks when their browser blocked the window.
 */

type ConnectProgressProps = {
  appName: string
  /**
   * Where a person adds an API key when the app wants one. The credential
   * dialog on the Connectors page owns that path; this panel only points at it,
   * because a second key form would be a second credential path.
   */
  credentialsHref?: string | null
  onDismiss?: () => void
  onReopenAuthorization: () => void
  onRetry: () => void
  /** The sign-in provider's name where it differs from the app's. */
  providerName?: string | null
  state: ConnectState
}

const panelClass = [
  'rounded-[var(--radius-md)] border border-[color:var(--sep)]',
  'bg-[color:var(--panel-soft)] px-4 py-3',
].join(' ')

const noticeClass = (tone: 'danger' | 'info') =>
  tone === 'info'
    ? [
      'rounded-[var(--radius-md)] border border-[color:var(--info-border)]',
      'bg-[color:var(--info-soft)] px-4 py-3 text-sm text-[color:var(--info-text)]',
    ].join(' ')
    : [
      'rounded-[var(--radius-md)] border border-[color:var(--danger-border)]',
      'bg-[color:var(--danger-soft)] px-4 py-3 text-sm text-[color:var(--danger-text)]',
    ].join(' ')

const StepRow = ({ step }: { step: ConnectStep }) => (
  <li className="flex items-center gap-2 text-sm">
    {step.status === 'done' ? (
      <span aria-hidden="true" className="text-[color:var(--success-text)]">✓</span>
    ) : step.status === 'active' ? (
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--executing)]"
      />
    ) : (
      <span aria-hidden="true" className="text-[color:var(--tx3)]">·</span>
    )}
    <span
      className={
        step.status === 'active'
          ? 'text-[color:var(--tx)]'
          : 'text-[color:var(--tx3)]'
      }
    >
      {step.label}
    </span>
  </li>
)

/** The raw code and server message, for an owner or for support — never open. */
const TechnicalDetails = ({ code, detail }: { code: string; detail: string | null }) => (
  <details className="mt-2">
    <summary className="cursor-pointer text-xs text-[color:var(--tx3)]">
      Technical details
    </summary>
    <p className="mt-1 text-xs break-words text-[color:var(--tx3)]">
      {detail ? `${code}: ${detail}` : code}
    </p>
  </details>
)

export const ConnectProgress = ({
  appName,
  credentialsHref,
  onDismiss,
  onReopenAuthorization,
  onRetry,
  providerName,
  state,
}: ConnectProgressProps) => {
  // Idle has nothing to say, and a finished connect is announced by the hero
  // flipping to its connected layout — repeating it here would be a second
  // claim about one fact.
  if (state.phase === 'idle' || state.phase === 'connected') return null

  const provider = providerName ?? appName

  if (state.phase === 'error' && state.error) {
    const presentation = connectErrorPresentation(state.error.code, {
      appName,
      providerName,
    })
    return (
      <div className={noticeClass(presentation.tone)} data-testid="app-connect-error" role="alert">
        <p>{presentation.message}</p>
        {presentation.retryLabel ? (
          <button
            className="admin-button admin-button-primary admin-button-compact mt-3"
            onClick={onRetry}
            type="button"
          >
            {presentation.retryLabel}
          </button>
        ) : null}
        <TechnicalDetails code={state.error.code} detail={state.error.detail} />
      </div>
    )
  }

  if (state.phase === 'needs_secret') {
    return (
      <div className={noticeClass('info')} data-testid="app-connect-needs-secret">
        <p>
          {appName} signs in with a key you hold. Add it once and Nessie keeps it
          encrypted — it is never shown again, here or anywhere else.
        </p>
        {credentialsHref ? (
          // An in-app route, so a router link: an `<a href>` here would reload
          // the whole admin to reach a page we are already inside.
          <Link
            className="admin-button admin-button-secondary admin-button-compact mt-3"
            to={credentialsHref}
          >
            Add the key
          </Link>
        ) : null}
      </div>
    )
  }

  const steps = connectSteps(state, provider)
  const waiting = state.phase === 'awaiting_authorization'

  return (
    // `role="status"` is already a polite live region, so the step list must not
    // declare a second one inside it — nested regions announce twice.
    <div className={panelClass} data-testid="app-connect-progress" role="status">
      <ul className="grid gap-1.5">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>

      {waiting && !state.popupBlocked ? (
        <div className="mt-3 border-t border-[color:var(--sep)] pt-3">
          <p className="text-sm font-medium text-[color:var(--tx)]">Waiting for {provider}…</p>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">
            Finish signing in in the window we opened. You can keep working here.
          </p>
          {connectShowsSlowProviderNote(state) ? (
            <p className="mt-1 text-xs text-[color:var(--tx3)]">
              Still waiting — {provider} can be slow to respond. You can close that
              window and try again.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              className="text-xs font-semibold text-[color:var(--accent)] underline"
              onClick={onReopenAuthorization}
              type="button"
            >
              Didn’t open? Open it again ↗
            </button>
            {onDismiss ? (
              <button
                className="text-xs text-[color:var(--tx3)] underline"
                onClick={onDismiss}
                type="button"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {waiting && state.popupBlocked && state.authorizationUrl ? (
        <div
          className={[
            'mt-3 rounded-[var(--radius-md)] border border-[color:var(--warning-border)]',
            'bg-[color:var(--warning-soft)] px-3 py-2 text-sm text-[color:var(--warning-text)]',
          ].join(' ')}
          data-testid="app-connect-popup-blocked"
          role="alert"
        >
          <p>
            Your browser blocked the sign-in window. Allow pop-ups for this site,
            or open sign-in directly:
          </p>
          {/* Same rule as the popup, said in markup: the page this opens is a
              third party's, and it must not hold a reference back to this tab.
              Completion comes back through the status read on focus either
              way — a plain link hands the flow to a tab we cannot watch. */}
          <a
            className="admin-button admin-button-secondary admin-button-compact mt-2"
            href={state.authorizationUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open sign-in ↗
          </a>
        </div>
      ) : null}
    </div>
  )
}
