import { useState } from 'react'
import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  useKnowledgeBacklinks,
  useKnowledgeMentions,
} from '../../../../facades/knowledge/backlinks-hooks'
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
    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
      {label} ({count})
    </span>
    <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={expanded ? faChevronDown : faChevronRight} />
  </button>
)

// "Linked from" (backlinks) + "Unlinked mentions" — the Obsidian-style panel
// that shows what else in the knowledge base points at this page. Both lists
// are lazy-fetched via react-query and collapsed by default (only the count
// shows until expanded); the whole section is omitted once loaded if both are
// empty, so there is no empty-state box taking up space.
export const BacklinksPanel = ({ pageId }: { pageId: string }) => {
  const { openPageDeepLink } = useKnowledge()
  const backlinksQuery = useKnowledgeBacklinks(pageId)
  const mentionsQuery = useKnowledgeMentions(pageId)
  const [backlinksOpen, setBacklinksOpen] = useState(false)
  const [mentionsOpen, setMentionsOpen] = useState(false)

  if (backlinksQuery.isLoading || mentionsQuery.isLoading) return null

  const backlinks = backlinksQuery.data ?? []
  const mentions = mentionsQuery.data ?? []
  if (backlinks.length === 0 && mentions.length === 0) return null

  return (
    <div className="mt-8 border-t border-[color:var(--sep)] pt-2">
      {backlinks.length > 0 ? (
        <div>
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
      ) : null}

      {mentions.length > 0 ? (
        <div>
          <SectionHeader
            count={mentions.length}
            expanded={mentionsOpen}
            label="Unlinked mentions"
            onToggle={() => setMentionsOpen((value) => !value)}
          />
          {mentionsOpen ? (
            <div className="flex flex-col gap-1 pb-2">
              {mentions.map((hit) => (
                <button
                  className="rounded-md px-2 py-1.5 text-left text-sm text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[color:var(--tx)]"
                  key={hit.pageId}
                  onClick={() => openPageDeepLink({ spaceId: hit.spaceId, pageId: hit.pageId })}
                  type="button"
                >
                  This page mentions <span className="font-medium text-[color:var(--tx)]">{hit.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
