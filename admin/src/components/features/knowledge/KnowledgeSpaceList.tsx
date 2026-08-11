import type { KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'

type KnowledgeSpaceListProps = {
  emptyLabel: string
  onSelect: (spaceId: string) => void
  selectedSpaceId?: string
  spaces: KnowledgeSpaceRecord[]
}

// The space rows themselves, shared by the Knowledge section's sidebar and a
// project's Documents tab. Both render the same list against the same
// selection callback; only the surrounding chrome (personal space, product
// views, headers) differs, so that stays with each caller.
export const KnowledgeSpaceList = ({
  emptyLabel,
  onSelect,
  selectedSpaceId,
  spaces,
}: KnowledgeSpaceListProps) => {
  if (spaces.length === 0) {
    return <div className="px-4 py-3 text-sm text-[color:var(--tx3)]">{emptyLabel}</div>
  }

  return (
    <>
      {spaces.map((space) => (
        <button
          className={['admin-sb-item', space.id === selectedSpaceId ? 'active' : ''].join(' ')}
          key={space.id}
          onClick={() => onSelect(space.id)}
          type="button"
        >
          <svg
            className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path d="M12 3l9 5-9 5-9-5 9-5z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 13l9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 flex-1 truncate">{space.name}</span>
          {space.memberAgentIds.length > 0 ? (
            <span
              className={[
                'flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
              ].join(' ')}
              title={`${space.memberAgentIds.length} agent${space.memberAgentIds.length === 1 ? '' : 's'} tagged in`}
            >
              {space.memberAgentIds.length} agent{space.memberAgentIds.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </button>
      ))}
    </>
  )
}
