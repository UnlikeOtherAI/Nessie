import type { DeepSignalSignalRecord } from '../../../lib/api-client'

// One insight card in the DeepSignal Signals digest: headline, why-it-matters,
// a status/kind badge row, timestamp, and done/snooze actions. Styling mirrors
// the message `uiCard` look (MessageUiCards) and is fully token-themed.

type SignalCardProps = {
  signal: DeepSignalSignalRecord
  acting: boolean
  onAct: (action: 'done' | 'snooze') => void
}

const statusClass = (status: DeepSignalSignalRecord['status']): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    status === 'done'
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : status === 'snoozed'
        ? 'bg-[var(--warning-soft)] text-[var(--warning-text)]'
        : status === 'muted'
          ? 'bg-[var(--overlay)] text-[var(--tx3)]'
          : 'bg-[var(--accent-soft)] text-[var(--thinking)]',
  ].join(' ')

const kindClass = (kind: NonNullable<DeepSignalSignalRecord['kind']>): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    kind === 'risk'
      ? 'bg-[var(--danger-soft)] text-[var(--danger-text)]'
      : 'bg-[var(--overlay)] text-[var(--tx2)]',
  ].join(' ')

const titleCase = (value: string): string =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const formatTimestamp = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

const actionClass = (variant: 'primary' | 'secondary'): string =>
  [
    'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'primary'
      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
      : 'border border-[var(--sep)] bg-[var(--overlay-weak)] text-[var(--tx2)]',
  ].join(' ')

const LaunchIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const SignalCard = ({ signal, acting, onAct }: SignalCardProps) => {
  const timestamp = signal.surfacedAt ? formatTimestamp(signal.surfacedAt) : ''
  const isActive = signal.status === 'active'
  return (
    <article className="rounded-lg border border-[var(--sep)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        {signal.kind ? (
          <span className={kindClass(signal.kind)}>{titleCase(signal.kind)}</span>
        ) : null}
        <span className={statusClass(signal.status)}>{titleCase(signal.status)}</span>
        {timestamp ? (
          <span className="ml-auto text-[11px] text-[var(--tx3)]">{timestamp}</span>
        ) : null}
      </div>
      <h3 className="mt-2 text-sm font-semibold text-[var(--tx)]">{signal.headline}</h3>
      {signal.summary ? (
        <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">{signal.summary}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {signal.deepLink ? (
          <a
            className={`${actionClass('secondary')} gap-1.5`}
            href={signal.deepLink}
            rel="noreferrer"
            target="_blank"
          >
            Open in DeepSignal
            <LaunchIcon />
          </a>
        ) : null}
        {isActive ? (
          <>
            <button
              className={actionClass('primary')}
              disabled={acting}
              onClick={() => onAct('done')}
              type="button"
            >
              Done
            </button>
            <button
              className={actionClass('secondary')}
              disabled={acting}
              onClick={() => onAct('snooze')}
              type="button"
            >
              Snooze
            </button>
          </>
        ) : null}
      </div>
    </article>
  )
}
