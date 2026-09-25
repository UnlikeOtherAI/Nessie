import { useState } from 'react'
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useKnowledgeBacklinks } from '../../../../facades/knowledge/backlinks-hooks'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { useKnowledge } from '../KnowledgeProvider'

const SectionHeader = ({
  count,
  expanded,
  label,
  onToggle,
}: {
  count: number
  expanded: boolean
  label: string
  onToggle: () => void
}) => (
  <button
    className="flex w-full items-center justify-between rounded-md px-1 py-2 text-left hover:bg-[var(--overlay-weak)]"
    onClick={onToggle}
    type="button"
  >
    <SectionLabel size="2xs">{label} ({count})</SectionLabel>
    <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={expanded ? faChevronDown : faChevronRight} />
  </button>
)

// "Linked from" shows pages that explicitly link to this page. It is
// lazy-fetched and collapsed by default; an empty section takes no space.
export const BacklinksPanel = ({ pageId }: { pageId: string }) => {
  const { openPageDeepLink } = useKnowledge()
  const backlinksQuery = useKnowledgeBacklinks(pageId)
  const [backlinksOpen, setBacklinksOpen] = useState(false)

  if (backlinksQuery.isLoading) return null

  const backlinks = backlinksQuery.data ?? []
  if (backlinks.length === 0) return null

  return (
    <div className="mt-8 border-t border-[color:var(--sep)] pt-2">
      <SectionHeader
        count={backlinks.length}
        expanded={backlinksOpen}
        label="Linked from"
        onToggle={() => setBacklinksOpen((value) => !value)}
      />
      {backlinksOpen ? (
        <div className="flex flex-col gap-1 pb-2">
          {backlinks.map((hit) => (
            <button
              className="rounded-md px-2 py-1.5 text-left hover:bg-[var(--overlay-weak)]"
              key={hit.pageId}
              onClick={() => openPageDeepLink({ spaceId: hit.spaceId, pageId: hit.pageId })}
              type="button"
            >
              <div className="text-sm text-[color:var(--tx)]">{hit.title}</div>
              {hit.snippet ? (
                <div className="text-xs text-[color:var(--tx3)]">{hit.snippet}</div>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
