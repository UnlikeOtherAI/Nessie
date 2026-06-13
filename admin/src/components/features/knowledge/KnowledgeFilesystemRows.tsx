import type { ReactNode } from 'react'
import {
  faChevronDown,
  faChevronRight,
  faFileLines,
  faFolder,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { iconForFilename } from './file-icons'
import { pageStatusTone } from './page-status'

export type KnowledgeFilesystemItemKind = 'file' | 'folder'

export const KnowledgeBreadcrumb = ({
  onBrowsePath,
  pathPages,
  rootLabel,
}: {
  onBrowsePath: (path: string[]) => void
  pathPages: KnowledgePageRecord[]
  rootLabel: string
}) => (
  <nav aria-label="Current folder" className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
    <button
      className="rounded px-1.5 py-1 text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
      onClick={() => onBrowsePath([])}
      type="button"
    >
      {rootLabel}
    </button>
    {pathPages.map((page, index) => (
      <span className="flex min-w-0 items-center gap-1" key={page.id}>
        <FontAwesomeIcon className="h-2.5 w-2.5 text-[color:var(--tx3)]" icon={faChevronRight} />
        <button
          className="max-w-52 truncate rounded px-1.5 py-1 text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
          onClick={() => onBrowsePath(pathPages.slice(0, index + 1).map((item) => item.id))}
          type="button"
        >
          {page.title}
        </button>
      </span>
    ))}
  </nav>
)

const KnowledgeItemIcon = ({
  kind,
  page,
}: {
  kind: KnowledgeFilesystemItemKind
  page: KnowledgePageRecord
}) => {
  // Folder → folder icon; file node → typed icon from its filename; document → text.
  const icon =
    kind === 'folder' ? faFolder : page.kind === 'file' ? iconForFilename(page.title) : faFileLines
  return (
    <FontAwesomeIcon
      className={[
        'h-4 w-4 flex-shrink-0',
        kind === 'folder' ? 'text-[color:var(--accent)]' : 'text-[color:var(--tx3)]',
      ].join(' ')}
      fixedWidth
      icon={icon}
    />
  )
}

export const KnowledgeItemRow = ({
  childCount,
  depth = 0,
  isExpanded,
  isSelected = false,
  kind,
  onClick,
  page,
  trailing,
}: {
  childCount: number
  depth?: number
  isExpanded?: boolean
  isSelected?: boolean
  kind: KnowledgeFilesystemItemKind
  onClick: () => void
  page: KnowledgePageRecord
  trailing?: ReactNode
}) => (
  <button
    aria-label={`${kind === 'folder' ? 'Open folder' : 'Open file'} ${page.title}`}
    className={[
      'group flex min-h-10 w-full items-center gap-2 rounded-md py-2 pr-3 text-left text-sm',
      'transition-colors',
      isSelected
        ? 'bg-[color:var(--overlay)] text-[color:var(--tx)]'
        : 'text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)] hover:text-[color:var(--tx)]',
    ].join(' ')}
    onClick={onClick}
    style={{ paddingLeft: `${12 + depth * 18}px` }}
    type="button"
  >
    <KnowledgeItemIcon kind={kind} page={page} />
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{page.title}</span>
      {page.summary ? (
        <span className="mt-0.5 block truncate text-xs text-[color:var(--tx3)]">{page.summary}</span>
      ) : null}
    </span>
    {kind === 'folder' ? (
      <span className="shrink-0 text-[11px] text-[color:var(--tx3)]">
        {childCount} {childCount === 1 ? 'item' : 'items'}
      </span>
    ) : page.kind === 'file' ? (
      <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[color:var(--tx3)]">
        file
      </span>
    ) : (
      <span className={`shrink-0 text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[page.status]}`}>
        {page.status}
      </span>
    )}
    {trailing ?? (
      kind === 'folder' ? (
        <FontAwesomeIcon
          className="h-3 w-3 shrink-0 text-[color:var(--tx3)]"
          icon={isExpanded ? faChevronDown : faChevronRight}
        />
      ) : null
    )}
  </button>
)

export const EmptyFolder = ({ label }: { label: string }) => (
  <div className="py-12 text-center text-sm text-[color:var(--tx3)]">{label}</div>
)
