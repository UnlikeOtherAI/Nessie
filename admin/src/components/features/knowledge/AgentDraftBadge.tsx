import { Pill } from '../../primitives/Pill'

// Compact chip flagging an unreviewed agent-authored draft, shown alongside
// (never instead of) the normal status label so reviewers can spot Librarian
// work waiting for a human pass without it changing existing status styling.
export const AgentDraftBadge = () => (
  <span title="Drafted by an agent — awaiting human review">
    <Pill size="sm" tone="accent">
      Agent draft
    </Pill>
  </span>
)
