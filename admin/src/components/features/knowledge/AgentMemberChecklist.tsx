import type { AgentRecord } from '../../../lib/api-client'

type AgentMemberChecklistProps = {
  agents: AgentRecord[]
  onChange: (agentIds: string[]) => void
  selectedAgentIds: string[]
}

// Checkbox list used to tag agents into a knowledge space (memberAgentIds).
// A tagged agent can read the space directly (and write, subject to
// writeRestricted) — this is how the Librarian agent and other assistants
// get access to private/channel/team scoped spaces.
export const AgentMemberChecklist = ({
  agents,
  onChange,
  selectedAgentIds,
}: AgentMemberChecklistProps) => {
  const selected = new Set(selectedAgentIds)

  const toggle = (agentId: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) {
      next.add(agentId)
    } else {
      next.delete(agentId)
    }
    onChange(Array.from(next))
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2 text-xs text-[color:var(--tx3)]">
        No agents available yet.
      </div>
    )
  }

  return (
    <div
      className={[
        'grid max-h-40 gap-1 overflow-y-auto rounded-lg border',
        'border-[color:var(--sep)] bg-[var(--scrim-weak)] p-2',
      ].join(' ')}
    >
      {agents.map((agent) => (
        <label
          className={[
            'flex items-center gap-2 rounded px-1.5 py-1 text-sm text-[color:var(--tx2)]',
            'hover:bg-[color:var(--overlay)]',
          ].join(' ')}
          key={agent.id}
        >
          <input
            checked={selected.has(agent.id)}
            className="accent-[var(--accent)]"
            onChange={(event) => toggle(agent.id, event.target.checked)}
            type="checkbox"
          />
          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
        </label>
      ))}
    </div>
  )
}
