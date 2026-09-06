import { faChevronDown, faFile, faFileLines } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { sidebarAriaCurrent } from '../../shared/row-a11y'

type KnowledgeSidebarPageTreeProps = {
  activePageId?: string
  childrenOf: (parentPageId: string) => KnowledgePageRecord[]
  onSelect: (path: string[]) => void
  rootPages: KnowledgePageRecord[]
}

const sorted = (pages: KnowledgePageRecord[]): KnowledgePageRecord[] =>
  [...pages].sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))

export const KnowledgeSidebarPageTree = ({
  activePageId,
  childrenOf,
  onSelect,
  rootPages,
}: KnowledgeSidebarPageTreeProps) => {
  const renderLevel = (pages: KnowledgePageRecord[], parentPath: string[], depth: number) => (
    <ul className={depth === 0 ? 'knowledge-sidebar-tree' : ''}>
      {sorted(pages).map((page) => {
        const path = [...parentPath, page.id]
        const children = sorted(childrenOf(page.id))
        const active = page.id === activePageId
        return (
          <li key={page.id}>
            <button
              aria-current={sidebarAriaCurrent(active)}
              className={['admin-sb-item sidebar-child', active ? 'active' : ''].join(' ')}
              onClick={() => onSelect(path)}
              style={{ paddingLeft: `${20 + depth * 16}px` }}
              type="button"
            >
              {children.length > 0 ? (
                <FontAwesomeIcon
                  className="h-2.5 w-2.5 flex-shrink-0 text-[color:var(--tx3)]"
                  fixedWidth
                  icon={faChevronDown}
                />
              ) : (
                <span aria-hidden="true" className="w-2.5 flex-shrink-0" />
              )}
              <FontAwesomeIcon
                className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
                fixedWidth
                icon={page.kind === 'document' ? faFileLines : faFile}
              />
              <span className="min-w-0 flex-1 truncate text-left">{page.title}</span>
            </button>
            {children.length > 0 ? renderLevel(children, path, depth + 1) : null}
          </li>
        )
      })}
    </ul>
  )

  return rootPages.length > 0 ? renderLevel(rootPages, [], 0) : null
}
