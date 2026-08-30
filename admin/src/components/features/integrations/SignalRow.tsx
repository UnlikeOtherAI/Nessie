import type { DeepSignalSignalRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import {
  formatTimestamp,
  kindPillTone,
  statusPillTone,
  titleCase,
  type SignalActionType,
} from './signal-format'

// One row in the DeepSignal Signals inbox: kind/status badges, headline,
// why-it-matters preview, timestamp, and inline act/snooze/mute. The headline
// area is a button that opens the detail drawer; the triage actions are sibling
// buttons (never nested) so acting in place doesn't also open the drawer.

type SignalRowProps = {
  signal: DeepSignalSignalRecord
  acting: boolean
  onOpen: (signal: DeepSignalSignalRecord) => void
  onAct: (action: SignalActionType) => void
}

const inlineActionClass = (variant: 'primary' | 'ghost'): string =>
  [
    'inline-flex h-7 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'primary'
      ? 'bg-[var(--accent)] text-[var(--on-accent)]'
      : 'border border-[var(--sep)] bg-[var(--overlay-weak)] text-[var(--tx2)] hover:text-[var(--tx)]',
  ].join(' ')

export const SignalRow = ({ signal, acting, onOpen, onAct }: SignalRowProps) => {
  const timestamp = formatTimestamp(signal.surfacedAt)
  const isActive = signal.status === 'active'
  return (
    <article
      className={[
        'flex flex-col gap-2 rounded-lg border border-[var(--sep)]',
        'bg-[var(--panel)] p-3.5 transition-colors focus-within:border-[var(--accent)]',
        'hover:border-[var(--accent)]',
      ].join(' ')}
    >
      <button
        className="flex w-full flex-col gap-1.5 rounded text-left"
        onClick={() => onOpen(signal)}
        type="button"
      >
        <span className="flex flex-wrap items-center gap-2">
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
          {!isActive ? (
            <Pill
              className="font-semibold"
              radius="chip"
              size="sm"
              tone={statusPillTone(signal.status)}
              uppercase={false}
            >
              {titleCase(signal.status)}
            </Pill>
          ) : null}
          {timestamp ? (
            <span className="ml-auto text-[11px] text-[var(--tx3)]">{timestamp}</span>
          ) : null}
        </span>
        <span className="text-sm font-semibold text-[var(--tx)]">{signal.headline}</span>
        {signal.summary ? (
          <span className="line-clamp-2 text-xs leading-5 text-[var(--tx2)]">{signal.summary}</span>
        ) : null}
      </button>
      {isActive ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={inlineActionClass('primary')}
            disabled={acting}
            onClick={() => onAct('done')}
            type="button"
          >
            {acting ? 'Working…' : 'Done'}
          </button>
          <button
            className={inlineActionClass('ghost')}
            disabled={acting}
            onClick={() => onAct('snooze')}
            type="button"
          >
            Snooze
          </button>
          <button
            className={inlineActionClass('ghost')}
            disabled={acting}
            onClick={() => onAct('mute')}
            type="button"
          >
            Mute
          </button>
        </div>
      ) : null}
    </article>
  )
}
