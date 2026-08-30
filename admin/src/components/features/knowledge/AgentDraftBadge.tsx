// Compact chip flagging an unreviewed agent-authored draft, shown alongside
// (never instead of) the normal status label so reviewers can spot Librarian
// work waiting for a human pass without it changing existing status styling.
// Unconverted: Pill's accent tone emits --thinking; this chip ships --accent.
export const AgentDraftBadge = () => (
  <span
    className={[
      'inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5',
      'text-[10px] font-semibold uppercase tracking-[0.12em]',
      'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
    ].join(' ')}
    title="Drafted by an agent — awaiting human review"
  >
    Agent draft
  </span>
)
