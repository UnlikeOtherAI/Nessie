import { useRef } from 'react'
import type { DeepSignalSignalRecord } from '../../../lib/api-client'
import { useModalA11y } from '../../shared/useModalA11y'
import { Pill } from '../../primitives/Pill'
import {
  formatTimestamp,
  kindPillTone,
  statusPillTone,
  titleCase,
  type SignalActionType,
} from './signal-format'

// Mission/detail view for one signal (deep-integration research §3: open an item
// to its full context + the resolution actions). Rendered as a right-side drawer
// with the full why-it-matters, the "Open in DeepSignal" deep link, and the
// act/snooze/mute resolution flow. Fully token-themed; a11y via useModalA11y.

type SignalDetailDrawerProps = {
  signal: DeepSignalSignalRecord
  acting: boolean
  onClose: () => void
  onAct: (action: SignalActionType) => void
}

const LaunchIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const resolutionActionClass = (variant: 'primary' | 'secondary'): string =>
  [
    'inline-flex h-9 items-center justify-center rounded-md px-3 text-xs font-semibold',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'primary'
      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
      : 'border border-[var(--sep)] bg-[var(--overlay-weak)] text-[var(--tx2)]',
  ].join(' ')

export const SignalDetailDrawer = ({ signal, acting, onClose, onAct }: SignalDetailDrawerProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  useModalA11y(panelRef, onClose)
  const timestamp = formatTimestamp(signal.surfacedAt)
  const isActive = signal.status === 'active'

  return (
    <>
      <button
        aria-label="Close signal details"
        className="fixed inset-0 z-40 bg-[var(--scrim-strong)]"
        onClick={onClose}
        type="button"
      />
      <div
        aria-label={signal.headline}
        aria-modal="true"
        className={[
          'fixed inset-y-0 right-0 z-50 flex w-[min(430px,100vw)] flex-col',
          'border-l border-[var(--sep)] bg-[var(--main)]',
          'shadow-[0_32px_80px_var(--scrim-strong)]',
        ].join(' ')}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex-shrink-0 border-b border-[var(--sep)] px-5 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {signal.kind ? (
                <Pill
                  className="font-semibold"
                  radius="chip"
                  size="sm"
                  tone={kindPillTone(signal.kind)}
                  uppercase={false}
                >
                  {titleCase(signal.kind)}
                </Pill>
              ) : null}
              <Pill
                className="font-semibold"
                radius="chip"
                size="sm"
                tone={statusPillTone(signal.status)}
                uppercase={false}
              >
                {titleCase(signal.status)}
              </Pill>
              {timestamp ? (
                <span className="text-[11px] text-[var(--tx3)]">{timestamp}</span>
              ) : null}
            </div>
            <button
              className="admin-button admin-button-secondary h-9"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
          <h2 className="mt-3 text-lg font-semibold text-[var(--tx)]">{signal.headline}</h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {signal.summary ? (
            <>
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--tx3)]">
                Why it matters
              </h3>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--tx2)]">
                {signal.summary}
              </p>
            </>
          ) : (
            <p className="text-sm leading-6 text-[var(--tx3)]">
              No further detail was provided for this signal.
            </p>
          )}
        </div>

        <footer className="flex-shrink-0 border-t border-[var(--sep)] px-5 py-4">
          {signal.deepLink ? (
            <a
              className={`${resolutionActionClass('secondary')} mb-3 w-full gap-1.5`}
              href={signal.deepLink}
              rel="noreferrer"
              target="_blank"
            >
              Open in DeepSignal
              <LaunchIcon />
            </a>
          ) : null}
          {isActive ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={resolutionActionClass('primary')}
                disabled={acting}
                onClick={() => onAct('done')}
                type="button"
              >
                {acting ? 'Working…' : 'Mark done'}
              </button>
              <button
                className={resolutionActionClass('secondary')}
                disabled={acting}
                onClick={() => onAct('snooze')}
                type="button"
              >
                Snooze
              </button>
              <button
                className={resolutionActionClass('secondary')}
                disabled={acting}
                onClick={() => onAct('mute')}
                type="button"
              >
                Mute
              </button>
            </div>
          ) : (
            <p className="text-xs text-[var(--tx3)]">
              This signal is {titleCase(signal.status).toLowerCase()}.
            </p>
          )}
        </footer>
      </div>
    </>
  )
}
