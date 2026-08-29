import type { AppDetailRecord } from '@nessie/schemas'
import { Link } from 'react-router-dom'
import { StatusPill } from '../../primitives/StatusPill'
import { AppIcon } from './AppIcon'
import { AppTrustBadge } from './AppTrustBadge'
import { appCardStatus, appUnavailableExplanation } from './app-card-presentation'
import {
  appDetailCta,
  appHeroMeta,
  appIsConnected,
  appProviderLine,
} from './app-detail-view'

type AppDetailHeroProps = {
  app: AppDetailRecord
  /** The connect flow already owns the outcome, so the CTA is spent. */
  connectInFlight: boolean
  onConnect: () => void
  onManageAccess: () => void
}

// The hero answers "what is this and what happens if I connect it?" — the app's
// mark, who publishes it, how far Nessie vouches for it, what it can do, and
// one control. Endpoints, transports and sign-in mechanics are not facts a
// person needs to decide that, so none of them render here.
export const AppDetailHero = ({
  app,
  connectInFlight,
  onConnect,
  onManageAccess,
}: AppDetailHeroProps) => {
  const cta = appDetailCta(app)
  const status = appCardStatus(app)
  const meta = appHeroMeta(app)
  const connected = appIsConnected(app)
  // Why this person cannot start the app themselves, said out loud.
  //
  // Two shapes reach here. `none` is the state with no control at all
  // (unavailable / turned off by an admin); `disabled` is a button that is
  // visible but cannot be pressed — an integration-managed app like Deep Water,
  // which is switched on from Integrations rather than connected here.
  //
  // The disabled case carries its reason in the button's `title`, which is
  // enough on a card but not here: a tooltip is invisible on touch and to
  // anyone who does not think to hover, and the detail view is the surface
  // whose whole job is to explain. A greyed button with no sentence beside it
  // is the exact dead end this page exists to prevent.
  //
  // The explanation is the same one the card's tooltip carries, plus the door
  // when a page owns the decision. `connecting` is the one disabled state with
  // no explanation of its own — it is not an availability verdict — so the
  // action's `title` stands in there.
  const explanation = appUnavailableExplanation(app)
  const blocked =
    cta.kind === 'disabled'
      ? { label: null, reason: explanation ?? { link: null, text: cta.title } }
      : cta.kind === 'none' && status.kind === 'quiet'
        ? { label: status.label, reason: explanation }
        : null

  return (
    <section
      className={[
        'rounded-[var(--radius-xl)] border border-[color:var(--line)]',
        'bg-[color:var(--panel)] p-6 sm:p-8',
      ].join(' ')}
      data-testid="app-detail-hero"
    >
      <div className="flex gap-4 sm:gap-5">
        <AppIcon displayName={app.displayName} iconUrl={app.iconUrl} size="hero" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-2xl font-semibold text-[color:var(--tx)]">
              {app.displayName}
            </h1>
            <AppTrustBadge trustLevel={app.trustLevel} />
            {status.kind === 'pill' ? (
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            ) : null}
          </div>
          <p className="text-sm text-[color:var(--tx2)]">{appProviderLine(app)}</p>

          <p
            className={[
              'mt-2 max-w-2xl border-t border-[color:var(--sep)] pt-4',
              'text-sm leading-6 text-[color:var(--tx2)]',
            ].join(' ')}
          >
            {app.longDescription ?? app.shortDescription}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cta.kind === 'connect' ? (
              // The one control on this page that acts rather than navigates.
              // While it is in flight it reads "Connecting…" and refuses a
              // second press — the panel underneath carries the detail, so the
              // button says only that it is spent.
              <button
                className={`admin-button admin-button-${cta.tone}`}
                data-testid="app-detail-cta"
                disabled={connectInFlight}
                onClick={onConnect}
                type="button"
              >
                {connectInFlight ? 'Connecting…' : cta.label}
              </button>
            ) : cta.kind === 'link' ? (
              <Link
                className={`admin-button admin-button-${cta.tone}`}
                data-testid="app-detail-cta"
                to={cta.href}
              >
                {cta.label}
              </Link>
            ) : cta.kind === 'disabled' ? (
              // Disabled styling belongs to `.admin-button:disabled` in
              // styles.css — an unlayered `.admin-button:hover` outranks any
              // `disabled:*` utility written here.
              <button
                className={`admin-button admin-button-${cta.tone}`}
                data-testid="app-detail-cta"
                disabled
                title={cta.title}
                type="button"
              >
                {cta.label}
              </button>
            ) : null}
            {blocked ? (
              <div className="flex flex-col gap-0.5" data-testid="app-detail-blocked">
                {blocked.label ? (
                  <span className="text-sm font-medium text-[color:var(--tx2)]">
                    {blocked.label}
                  </span>
                ) : null}
                {blocked.reason ? (
                  <span className="text-xs text-[color:var(--tx3)]">
                    {blocked.reason.text}
                    {/* Naming the door is not opening it: a member told the app
                        lives in Integrations still has to go and find it. */}
                    {blocked.reason.link ? (
                      <>
                        {' '}
                        <Link
                          className="underline"
                          data-testid="app-detail-blocked-link"
                          to={blocked.reason.link.href}
                        >
                          {blocked.reason.link.label}
                        </Link>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
            ) : null}
            {connected ? (
              <button
                className="admin-button admin-button-secondary"
                data-testid="app-detail-manage-access"
                onClick={onManageAccess}
                type="button"
              >
                Manage access
              </button>
            ) : null}
          </div>

          {meta ? <p className="mt-2 text-xs text-[color:var(--tx3)]">{meta}</p> : null}
        </div>
      </div>
    </section>
  )
}
