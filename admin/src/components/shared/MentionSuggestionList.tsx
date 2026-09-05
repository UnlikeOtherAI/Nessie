import type { RefObject } from 'react'
import { AgentVisibilityPill } from '../features/agents/AgentVisibilityPill'
import { MentionEntityAvatar } from './MentionEntityAvatar'
import type { MentionEntity } from './MentionInput'

type Props = {
  filtered: MentionEntity[]
  listRef: RefObject<HTMLDivElement | null>
  onHover: (index: number) => void
  onPick: (entity: MentionEntity) => void
  selectedIdx: number
}

// The suggestion popup for `MentionInput`'s "@"/"#" trigger. Pure
// presentation over the filtered entity list the controller already
// computed; selection and commit are both handed back through props.
export const MentionSuggestionList = ({ filtered, listRef, onHover, onPick, selectedIdx }: Props) => (
  <div
    ref={listRef}
    className={[
      'absolute bottom-full left-0 z-[var(--layer-popover)] mb-1 max-h-[220px] w-[320px] max-w-[calc(100vw-40px)]',
      'overflow-y-auto rounded-lg border border-[color:var(--sep)]',
      'bg-[color:var(--main)] shadow-xl',
    ].join(' ')}
  >
    {filtered.map((entity, i) => (
      <button
        key={`${entity.type}:${entity.id}:${entity.principalUserId ?? ''}`}
        className={[
          'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
          i === selectedIdx
            ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
            : 'text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]',
        ].join(' ')}
        onMouseDown={(e) => {
          e.preventDefault()
          onPick(entity)
        }}
        onMouseEnter={() => onHover(i)}
        type="button"
      >
        <MentionEntityAvatar entity={entity} />
        <span className="min-w-0 flex flex-col">
          <span className="truncate">{entity.name}</span>
          {entity.detail ? (
            <span className="truncate text-xs opacity-60">{entity.detail}</span>
          ) : null}
        </span>
        <span className="ml-auto flex-shrink-0">
          {entity.type === 'agent' && entity.agentVisibility ? (
            <AgentVisibilityPill visibility={entity.agentVisibility} />
          ) : (
            <span className="text-xs opacity-50">{entity.type}</span>
          )}
        </span>
      </button>
    ))}
  </div>
)
