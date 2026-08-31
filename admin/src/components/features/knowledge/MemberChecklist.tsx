export type KnowledgeMemberOption = {
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
    return (
      <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2 text-xs text-[color:var(--tx3)]">
        {emptyLabel}
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
      {members.map((member) => (
        <label
          className={[
            'flex items-center gap-2 rounded px-1.5 py-1 text-sm text-[color:var(--tx2)]',
            'hover:bg-[color:var(--overlay)]',
          ].join(' ')}
          key={member.id}
        >
          <input
            checked={selected.has(member.id)}
            className="accent-[var(--accent)]"
            onChange={(event) => toggle(member.id, event.target.checked)}
            type="checkbox"
          />
          <span className="min-w-0 flex-1 truncate">{member.label}</span>
        </label>
      ))}
    </div>
  )
}
