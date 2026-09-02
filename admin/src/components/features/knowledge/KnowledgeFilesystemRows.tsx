import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  faChevronDown,
  faChevronRight,
  faFileLines,
  faFolder,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { Input } from '../../shared/FormControls'
import { EmptyState } from '../../shared/EmptyState'
import { Row } from '../../shared/RowList'
import { Pill } from '../../primitives/Pill'
import { AgentDraftBadge } from './AgentDraftBadge'
import { iconForFilename } from './file-icons'
import { isAgentDraft, pageStatusPillTone } from './page-status'

export type KnowledgeFilesystemItemKind = 'file' | 'folder'

// A page renders as a folder when it explicitly is one (an empty folder created
// via "New folder", flagged `metadata.folder`) or when it already holds children.
export const isFolderPage = (
  page: KnowledgePageRecord,
  childrenOf: (parentPageId: string) => KnowledgePageRecord[],
): boolean => page.metadata?.folder === true || childrenOf(page.id).length > 0

// Folders first, then by position / title — shared by every knowledge view.
export const sortFilesystemPages = (
  pages: KnowledgePageRecord[],
  childrenOf: (parentPageId: string) => KnowledgePageRecord[],
): KnowledgePageRecord[] =>
  [...pages].sort((left, right) => {
    const leftFolder = isFolderPage(left, childrenOf)
    const rightFolder = isFolderPage(right, childrenOf)
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1
    return left.position - right.position || left.title.localeCompare(right.title)
  })

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

const KnowledgeItemTrailing = ({
  childCount,
  kind,
  page,
}: {
  childCount: number
  kind: KnowledgeFilesystemItemKind
  page: KnowledgePageRecord
}) =>
  kind === 'folder' ? (
    <span className="shrink-0 text-[11px] text-[color:var(--tx3)]">
      {childCount} {childCount === 1 ? 'item' : 'items'}
    </span>
  ) : page.kind === 'file' ? (
    <Pill size="sm" tone="muted">
      file
    </Pill>
  ) : (
    <>
      {isAgentDraft(page) ? <AgentDraftBadge /> : null}
      <Pill size="sm" tone={pageStatusPillTone[page.status]}>
        {page.status}
      </Pill>
    </>
  )

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
  <Row
    depth={depth}
    leading={<KnowledgeItemIcon kind={kind} page={page} />}
    onClick={onClick}
    selected={isSelected}
    subtitle={page.summary}
    title={page.title}
    trailing={
      <>
        <KnowledgeItemTrailing childCount={childCount} kind={kind} page={page} />
        {trailing ?? (
          kind === 'folder' ? (
            <FontAwesomeIcon
              className="h-3 w-3 shrink-0 text-[color:var(--tx3)]"
              icon={isExpanded ? faChevronDown : faChevronRight}
            />
          ) : null
        )}
      </>
    }
  />
)

export const EmptyFolder = ({ label }: { label: string }) => <EmptyState>{label}</EmptyState>

// Finder-style inline "new folder" row: a folder icon + an auto-focused name
// field. Enter creates, Escape cancels, and blurring submits a typed name (or
// cancels when empty). A guard makes submit/cancel fire at most once.
export const NewFolderRow = ({
  onCancel,
  onSubmit,
  pending,
}: {
  onCancel: () => void
  onSubmit: (name: string) => void
  pending: boolean
}) => {
  const [name, setName] = useState('')
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Not `autoFocus`: the browser's own initial focus scrolls whatever box it
  // lands in, which is the sideways bounce docs/navigation.md §2 names.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const finish = (action: () => void) => {
    if (doneRef.current) return
    doneRef.current = true
    action()
  }
  const submit = () => {
    const trimmed = name.trim()
    finish(() => (trimmed ? onSubmit(trimmed) : onCancel()))
  }

  return (
    <div className="flex min-h-10 items-center gap-2 rounded-md py-2 pl-3 pr-3">
      <FontAwesomeIcon
        className="h-4 w-4 flex-shrink-0 text-[color:var(--accent)]"
        fixedWidth
        icon={faFolder}
      />
      <Input
        aria-label="Folder name"
        className="min-w-0 flex-1"
        disabled={pending}
        onBlur={submit}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(onCancel)
          }
        }}
        placeholder="Folder name"
        ref={inputRef}
        size="compact"
        value={name}
      />
    </div>
  )
}
