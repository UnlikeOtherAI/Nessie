/**
 * The chrome every widget wears, on every surface.
 *
 * The freshness footer is not optional and not removable by an author. A
 * confidently-rendered stale number is worse than an error, so a widget always
 * says how old its data is — that guarantee only holds if the footer lives in
 * the frame rather than in each renderer.
 */

import type { ReactNode } from 'react'
import type {
  DashboardWidgetProjection,
  WidgetPresentation,
} from '@nessie/schemas'
import { Skeleton } from '../../primitives/Skeleton'
import { formatRelative, formatTemporal as formatMoment } from './widget-format'

type WidgetFrameProps = {
  presentation?: WidgetPresentation
  projection: DashboardWidgetProjection
  children: ReactNode
  onRetry?: () => void
  compact?: boolean
}

const stateDot: Record<string, string> = {
  fresh: 'var(--executing)',
  stale: 'var(--warning)',
  error: 'var(--danger)',
  empty: 'var(--tx3)',
  loading: 'var(--tx3)',
  denied: 'var(--tx3)',
  unsupported: 'var(--tx3)',
}

const FreshnessFooter = ({ projection }: { projection: DashboardWidgetProjection }) => {
  const { state, fetchedAt, errorCode } = projection
  // A frozen snapshot must never say "Live". It carries a snapshotId, and that
  // is the only thing separating "these numbers are current" from "these are a
  // quotation of a past moment" — getting it wrong is precisely the
  // confidently-wrong reading the footer exists to prevent.
  const frozen = Boolean(projection.snapshotId)

  const label = (() => {
    if (frozen) {
      return `Snapshot · ${fetchedAt ? formatMoment(fetchedAt) : 'a past moment'}`
    }
    switch (state) {
      case 'fresh':
        return `Live · ${formatRelative(fetchedAt)}`
      case 'stale':
        return `Stale · updated ${formatRelative(fetchedAt)}`
      case 'empty':
        return `No data returned · ${formatRelative(fetchedAt)}`
      case 'loading':
        return 'Waiting for its first refresh'
      case 'denied':
        return 'You do not have access to this data'
      case 'unsupported':
        return 'Needs an administrator update'
      case 'error':
      default:
        return fetchedAt ? `Refresh failed · showing ${formatRelative(fetchedAt)}` : 'Data unavailable'
    }
  })()

  return (
    <div
      className={[
        'mt-2 flex items-center gap-1.5 text-[11px]',
        !frozen && state === 'stale' ? 'text-[color:var(--warning-text)]' : 'text-[color:var(--tx3)]',
      ].join(' ')}
      data-testid="widget-freshness"
    >
      <span aria-hidden>{frozen ? '📌' : null}</span>
      {frozen ? null : (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: stateDot[state] ?? 'var(--tx3)' }}
        />
      )}
      <span>{label}</span>
      {/* A stable code, never an upstream message. */}
      {errorCode && state !== 'fresh' ? (
        <span className="text-[color:var(--tx3)]">· {errorCode}</span>
      ) : null}
      {projection.authorityLabel ? (
        <span className="ml-auto" title="Whose access refreshes this data">
          {projection.authorityLabel}
        </span>
      ) : null}
    </div>
  )
}

export const WidgetFrame = ({
  presentation,
  projection,
  children,
  onRetry,
  compact,
}: WidgetFrameProps) => {
  const emphasis = presentation?.style === 'emphasis'
  const dense = compact || presentation?.density === 'compact'
  const quiet = presentation?.style === 'compact'

  return (
    <section
      className={[
        'flex h-full flex-col overflow-hidden rounded-lg',
        quiet ? '' : 'border',
        dense ? 'p-2.5' : 'p-3.5',
      ].join(' ')}
      style={{
        background: quiet ? 'transparent' : 'var(--panel)',
        borderColor: 'var(--sep)',
        ...(emphasis ? { borderTop: '2px solid var(--border-strong)' } : {}),
      }}
      data-testid="dashboard-widget"
      data-widget-state={projection.state}
      data-widget-kind={projection.kind}
    >
      <header className="mb-1.5 min-w-0">
        {/* Author-supplied strings are React text nodes. Never markup. */}
        <h3
          className={[
            'truncate font-semibold text-[color:var(--tx)]',
            emphasis ? 'text-base' : 'text-sm',
          ].join(' ')}
          title={presentation?.title}
        >
          {presentation?.title ?? 'Widget'}
        </h3>
        {presentation?.subtitle && !dense ? (
          <p className="truncate text-[11px] uppercase tracking-wide text-[color:var(--tx3)]">
            {presentation.subtitle}
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1">{children}</div>

      {presentation?.caption && !dense ? (
        <p className="mt-2 text-xs text-[color:var(--tx2)]">
          {presentation.caption}
        </p>
      ) : null}

      {projection.state === 'error' && onRetry ? (
        <button
          className="mt-2 self-start rounded bg-[color:var(--overlay-weak)] px-2 py-1 text-xs text-[color:var(--tx2)]"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      ) : null}

      <FreshnessFooter projection={projection} />
    </section>
  )
}

// The same tone→token pairs `Pill` draws its chips from — a placeholder is a
// filled panel rather than a chip, so it composes the pair directly instead
// of wearing a chip shape.
const placeholderToneClasses: Record<'neutral' | 'warning' | 'danger', string> = {
  danger: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  neutral: 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]',
  warning: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
}

/** Shown when data cannot be rendered. Carries server copy only. */
export const WidgetPlaceholder = ({
  title,
  detail,
  tone = 'neutral',
}: {
  title: string
  detail?: string
  tone?: 'neutral' | 'warning' | 'danger'
}) => (
  <div
    className={[
      'flex h-full min-h-[64px] flex-col items-start justify-center gap-1 rounded px-3 py-2 text-xs',
      placeholderToneClasses[tone],
    ].join(' ')}
  >
    <span className="font-medium">{title}</span>
    {detail ? <span>{detail}</span> : null}
  </div>
)

/** First-load shimmer: keeps the frame's height so the grid does not jump. */
export const WidgetSkeleton = () => <Skeleton className="min-h-[64px]" height="h-full" />
