import { useState } from 'react'
import type { AppSummaryRecord } from '@nessie/schemas'
import { Link } from 'react-router-dom'
import { AppConnectDialog } from './AppConnectDialog'
import { StatusPill } from '../../primitives/StatusPill'
import { AppIcon } from './AppIcon'
import { AppTrustBadge } from './AppTrustBadge'
import {
  appCardAction,
  appCardMeta,
  appCardStatus,
  appCardTestId,
  appCategoryLabel,
  appDetailHref,
  appKindPill,
  type AppKindPillTone,
} from './app-card-presentation'
import { highlightSegments } from './app-search'
import { showsTrustBadgeOnCard } from './app-trust'

/**
 * The one card for every app — remote, built-in, custom. Which kind it is shows
 * in its pill and its action, never in a different layout: a shelf reads as a
 * shelf only while every tile has the same shape.
 */

type AppCardProps = {
  app: AppSummaryRecord
  /** `wide` is the Featured strip's tile; same component, more width. */
  layout?: 'grid' | 'wide'
  /** Why this app matched, when the match landed somewhere invisible. */
  provenance?: string | null
  /** The live search term, so the matched run can be marked in place. */
  query?: string
}

const KIND_PILL_TONE: Record<AppKindPillTone, string> = {
  // `--thinking` is the accent-family foreground each theme tuned to sit on
  // `--accent-soft`; `--accent` itself is a fill colour and goes muddy on it.
  accent: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  info: 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  neutral: 'bg-[color:var(--overlay-weak)] text-[color:var(--tx2)]',
}

const ACTION_TONE = {
  primary: 'admin-button admin-button-compact admin-button-primary',
  secondary: 'admin-button admin-button-compact admin-button-secondary',
} as const

const HighlightedText = ({ query, text }: { query: string; text: string }) => (
  <>
    {highlightSegments(text, query).map((segment, index) =>
      segment.match ? (
        <mark
          className="rounded-sm bg-[color:var(--accent-soft)] px-0.5 text-[color:var(--thinking)]"
          key={`${index}-${segment.text}`}
        >
          {segment.text}
        </mark>
      ) : (
        <span key={`${index}-${segment.text}`}>{segment.text}</span>
      ),
    )}
  </>
)

export const AppCard = ({ app, layout = 'grid', provenance = null, query = '' }: AppCardProps) => {
  const [connectOpen, setConnectOpen] = useState(false)
  const status = appCardStatus(app)
  const action = appCardAction(app)
  const kindPill = appKindPill(app)
  const meta = appCardMeta(app)

  return (
    <article
      className={[
        'relative flex h-full flex-col gap-3 p-4',
        'rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel)]',
        'transition-colors duration-[var(--duration-fast)]',
        'cursor-pointer hover:border-[color:var(--border-strong)] hover:bg-[color:var(--main-hover)]',
        layout === 'wide' ? 'w-64 shrink-0 snap-start' : '',
      ].join(' ')}
      data-app-state={app.state}
      data-testid={appCardTestId(app)}
    >
      <div className="flex items-start gap-3">
        <AppIcon displayName={app.displayName} iconUrl={app.iconUrl} size="card" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Title and badge wrap instead of competing: on a narrow tile (the
              phone two-column grid, the featured strip) a shrink-0 chip beside
              a shrinkable title starves the title down to a couple of
              characters, so the badge drops under the title before the title
              gives up a pixel. The title clamps at two lines and holds that
              height even when short, keeping every card in a row the same
              shape. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* A stretched link: real anchor semantics and one tab stop for the
                whole tile, while the footer action stays its own control (an
                anchor inside an anchor would not be valid markup). Every state
                gets one — a card that cannot be opened has nowhere to send a
                person whose install has stalled or whose app is unavailable. */}
            <Link
              className={[
                'line-clamp-2 min-h-10 min-w-0 text-[0.9375rem] font-semibold leading-5',
                'text-[color:var(--tx)]',
                'after:absolute after:inset-0 after:content-[""]',
                'focus-visible:outline-none focus-visible:after:ring-2',
                'focus-visible:after:ring-[color:var(--accent)]',
                'focus-visible:after:rounded-[var(--radius-lg)]',
              ].join(' ')}
              data-testid="app-card-open"
              to={appDetailHref(app)}
            >
              <HighlightedText query={query} text={app.displayName} />
            </Link>
            {showsTrustBadgeOnCard(app.trustLevel) ? (
              <AppTrustBadge trustLevel={app.trustLevel} />
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 truncate text-[11px]">
            <span className="text-[color:var(--tx3)]">{appCategoryLabel(app)}</span>
            {kindPill ? (
              <span
                className={[
                  'rounded-full px-2 py-0.5 font-medium',
                  KIND_PILL_TONE[kindPill.tone],
                ].join(' ')}
              >
                {kindPill.label}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[2.5rem] text-sm leading-5 text-[color:var(--tx2)]">
        <HighlightedText query={query} text={app.shortDescription} />
      </p>

      {provenance ? (
        <p className="truncate text-xs text-[color:var(--tx3)]">{provenance}</p>
      ) : null}

      {meta ? (
        // Hidden in the two-column phone grid, where a card is too narrow to
        // carry it without pushing the footers out of alignment.
        <p className="hidden truncate text-xs text-[color:var(--tx3)] sm:block">{meta}</p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <div className="min-w-0">
          {status.kind === 'pill' ? (
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          ) : status.kind === 'quiet' ? (
            <span className="truncate text-xs text-[color:var(--tx3)]">{status.label}</span>
          ) : null}
        </div>
        {action.kind === 'link' ? (
          <Link
            className={`${ACTION_TONE[action.tone]} relative z-10`}
            data-testid="app-card-action"
            to={action.href}
          >
            {action.label}
          </Link>
        ) : action.kind === 'connect' ? (
          // Connect stays on this page: the dialog runs the same flow the
          // detail hero drives, so pressing it never navigates away.
          <button
            className={`${ACTION_TONE[action.tone]} relative z-10`}
            data-testid="app-card-action"
            onClick={() => setConnectOpen(true)}
            type="button"
          >
            {action.label}
          </button>
        ) : action.kind === 'disabled' ? (
          <button
            // Disabled styling belongs to `.admin-button:disabled` in
            // styles.css — an unlayered `.admin-button:hover` outranks any
            // `disabled:*` utility written here.
            className={`${ACTION_TONE[action.tone]} relative z-10`}
            data-testid="app-card-action"
            disabled
            title={action.title}
            type="button"
          >
            {action.label}
          </button>
        ) : null}
      </div>

      <AppConnectDialog app={app} onClose={() => setConnectOpen(false)} open={connectOpen} />
    </article>
  )
}
