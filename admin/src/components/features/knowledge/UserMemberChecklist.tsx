export type KnowledgeUserOption = {
  displayName: string
  id: string
}

type UserMemberChecklistProps = {
  onChange: (userIds: string[]) => void
  selectedUserIds: string[]
  users: KnowledgeUserOption[]
}

/** Checkbox list for the user half of KnowledgeSpaceMember. */
export const UserMemberChecklist = ({
  onChange,
  selectedUserIds,
  users,
}: UserMemberChecklistProps) => {
  const selected = new Set(selectedUserIds)
  const toggle = (userId: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(userId)
    else next.delete(userId)
    onChange(Array.from(next))
  }

  if (users.length === 0) {
    return (
      <div className="rounded-lg border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2 text-xs text-[color:var(--tx3)]">
        No people available.
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
      {users.map((user) => (
        <label
          className={[
            'flex items-center gap-2 rounded px-1.5 py-1 text-sm text-[color:var(--tx2)]',
            'hover:bg-[color:var(--overlay)]',
          ].join(' ')}
          key={user.id}
        >
          <input
            checked={selected.has(user.id)}
            className="accent-[var(--accent)]"
            onChange={(event) => toggle(user.id, event.target.checked)}
            type="checkbox"
          />
          <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
        </label>
      ))}
    </div>
  )
}
