import type { AgentVisibility } from '@nessie/schemas'

import { AgentVisibilityPill } from '../agents/AgentVisibilityPill'
import { Checkbox } from '../../primitives/Checkbox'
import { EmptyState } from '../../shared/EmptyState'

export type KnowledgeMemberOption = {
  agentVisibility?: AgentVisibility
  id: string
  label: string
}

type MemberChecklistProps = {
  emptyLabel: string
  members: KnowledgeMemberOption[]
  onChange: (ids: string[]) => void
  selectedIds: string[]
}

/** Shared checkbox list for either human or agent KnowledgeSpaceMember rows. */
export const MemberChecklist = ({
  emptyLabel,
  members,
  onChange,
  selectedIds,
}: MemberChecklistProps) => {
  const selected = new Set(selectedIds)
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    onChange(Array.from(next))
  }

  if (members.length === 0) {
    return <EmptyState>{emptyLabel}</EmptyState>
  }

  return (
    <div
      className={[
        'grid max-h-40 gap-1 overflow-y-auto rounded-lg border',
        'border-[color:var(--sep)] bg-[var(--scrim-weak)] p-2',
      ].join(' ')}
    >
      {members.map((member) => (
        <div
          className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[color:var(--overlay)]"
          key={member.id}
        >
          <div className="min-w-0 flex-1">
            <Checkbox
              checked={selected.has(member.id)}
              label={member.label}
              onChange={(checked) => toggle(member.id, checked)}
            />
          </div>
          {member.agentVisibility ? (
            <AgentVisibilityPill visibility={member.agentVisibility} />
          ) : null}
        </div>
      ))}
    </div>
  )
}
