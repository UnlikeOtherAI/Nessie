import type { DeepSignalSignalKind, DeepSignalSignalRecord } from '../../../lib/api-client'

// Shared presentation helpers for the DeepSignal Signals inbox — the row, the
// detail drawer, and the overview header all read kinds/status the same way, so
// the formatting lives here rather than being duplicated per component. Fully
// token-themed; no raw colour.

export type SignalActionType = 'done' | 'snooze' | 'mute'

export const KIND_LABEL: Record<DeepSignalSignalKind | 'other', string> = {
  risk: 'Risks',
  opportunity: 'Opportunities',
  signal: 'Signals',
  other: 'Signals',
}

// Risks first (most urgent to triage), then opportunities, then generic signals,
// then anything without a kind — a graceful default since the digest exposes no
// severity/priority field to sort on.
export const KIND_ORDER: Array<DeepSignalSignalKind | 'other'> = [
  'risk',
  'opportunity',
  'signal',
  'other',
]

export const titleCase = (value: string): string =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

export const formatTimestamp = (value: string | null): string => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const kindBadgeClass = (kind: DeepSignalSignalKind): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    kind === 'risk'
      ? 'bg-[var(--danger-soft)] text-[var(--danger-text)]'
      : kind === 'opportunity'
        ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
        : 'bg-[var(--overlay)] text-[var(--tx2)]',
  ].join(' ')

export const statusBadgeClass = (status: DeepSignalSignalRecord['status']): string =>
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

const kindOf = (signal: DeepSignalSignalRecord): DeepSignalSignalKind | 'other' =>
  signal.kind ?? 'other'

const recencyValue = (signal: DeepSignalSignalRecord): number => {
  if (!signal.surfacedAt) return 0
  const time = new Date(signal.surfacedAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

export type SignalGroup = {
  kind: DeepSignalSignalKind | 'other'
  label: string
  signals: DeepSignalSignalRecord[]
}

/**
 * Group signals by kind in triage order (risks first), newest first within each
 * group. Empty groups are dropped so the inbox only renders kinds that exist.
 */
export const groupSignalsByKind = (signals: DeepSignalSignalRecord[]): SignalGroup[] => {
  const byKind = new Map<DeepSignalSignalKind | 'other', DeepSignalSignalRecord[]>()
  for (const signal of signals) {
    const key = kindOf(signal)
    const bucket = byKind.get(key) ?? []
    bucket.push(signal)
    byKind.set(key, bucket)
  }
  return KIND_ORDER.flatMap((kind) => {
    const bucket = byKind.get(kind)
    if (!bucket || bucket.length === 0) return []
    bucket.sort((a, b) => recencyValue(b) - recencyValue(a))
    return [{ kind, label: KIND_LABEL[kind], signals: bucket }]
  })
}

export type SignalCounts = {
  needAttention: number
  opportunities: number
  risks: number
  signals: number
}

/** Overview tallies: active items need attention; kind counts span all items. */
export const summarizeSignals = (signals: DeepSignalSignalRecord[]): SignalCounts => {
  let needAttention = 0
  let opportunities = 0
  let risks = 0
  let others = 0
  for (const signal of signals) {
    if (signal.status === 'active') needAttention += 1
    if (signal.kind === 'opportunity') opportunities += 1
    else if (signal.kind === 'risk') risks += 1
    else others += 1
  }
  return { needAttention, opportunities, risks, signals: others }
}
