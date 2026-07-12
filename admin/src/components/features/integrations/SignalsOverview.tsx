import type { SignalCounts } from './signal-format'

// Brief overview header for the Signals inbox (deep-integration research §3): a
// one-glance tally of what needs attention and the kind mix, so the first thing
// the user sees answers "what should I look at?" — not a settings list.

type SignalsOverviewProps = {
  counts: SignalCounts
  includeAll: boolean
  onToggleIncludeAll: (value: boolean) => void
}

const Stat = ({ value, label }: { value: number; label: string }) => (
  <span className="text-[var(--tx3)]">
    <span className="font-semibold text-[var(--tx2)]">{value}</span> {label}
  </span>
)

const attentionSummary = (counts: SignalCounts): string => {
  if (counts.needAttention === 0) return 'Nothing needs your attention'
  return `${counts.needAttention} need${counts.needAttention === 1 ? 's' : ''} attention`
}

export const SignalsOverview = ({
  counts,
  includeAll,
  onToggleIncludeAll,
}: SignalsOverviewProps) => (
  <div className="mb-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-lg font-semibold text-[var(--tx)]">Signals</h1>
      <label className="flex items-center gap-2 text-xs text-[var(--tx3)]">
        <input
          checked={includeAll}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
          onChange={(event) => onToggleIncludeAll(event.target.checked)}
          type="checkbox"
        />
        Show resolved
      </label>
    </div>
    <p className="mt-1 text-sm font-medium text-[var(--tx)]">{attentionSummary(counts)}</p>
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {counts.opportunities > 0 ? <Stat label="opportunities" value={counts.opportunities} /> : null}
      {counts.risks > 0 ? <Stat label="risks" value={counts.risks} /> : null}
      {counts.signals > 0 ? <Stat label="signals" value={counts.signals} /> : null}
    </div>
  </div>
)
