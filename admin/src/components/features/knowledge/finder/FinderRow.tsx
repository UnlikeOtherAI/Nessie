import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react'
import {
  faChevronRight,
  faLock,
  faUserGroup,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeIndexingState } from '@nessie/schemas'
import { familyForFilename, familyLabel } from '../../../shared/file-icons'
import { MiddleTruncate } from '../../../shared/MiddleTruncate'
import { Row, type RowDragHandlers, type RowProps } from '../../../shared/RowList'
import { indexingCopy } from './indexing-copy'
import { RenameRow, type FinderRowRename } from './RenameRow'

/**
 * One row of the Documents Finder (browser-ui.md §4). 44px, an icon, a
 * middle-truncated name, whatever the row has to say about itself, and a
 * chevron where there is somewhere to go. No border between rows, no zebra
 * striping: the selection is the only thing that paints.
 *
 * It is the shared `Row` in its `finder` mode, not a fourth row component —
 * the 2026-09-01 audit counted six of those.
 *
 * **What Wave 2 attaches to.** `onContextMenu` is declared and unconnected
 * here; every row carries `data-finder-row` with its id and
 * `data-finder-kind`, and a folder row carries `data-finder-folder="true"`,
 * so a menu, a rename or a drop layer can find a row without this component
 * learning about any of them.
 */

export type FinderRowVariant = 'item' | 'root' | 'virtual' | 'upload'

export type FinderRowUpload = {
  /** 0–100 while the bytes are going up; absent for a queued file. */
  pct?: number
  /** Set when the upload was refused; replaces the progress line. */
  error?: string
  /** "Waiting…", "Uploading…", "Indexing…" — the queue's own word. */
  label?: string
}

export type FinderRowProps = {
  /** Announced in place of the title where the title does not say what opens. */
  ariaLabel?: string
  columnActive?: boolean
  /** A chevron on folders and root rows — somewhere to go, not something to do. */
  chevron?: boolean
  disabled?: boolean
  dragHandlers?: RowDragHandlers
  draggable?: boolean
  dragging?: boolean
  dropTarget?: boolean
  elementRef?: Ref<HTMLButtonElement>
  /** A shared folder the viewer may read but not write takes a lock badge. */
  locked?: boolean
  icon?: IconDefinition
  /** The CSS custom property name the glyph is painted with (`--accent`). */
  iconTone?: string
  id: string
  indexing?: KnowledgeIndexingState
  /** An identity tile in place of a glyph: a project's picture, an agent's. */
  leading?: ReactNode
  /**
   * List view's Date modified / Size / Kind cells, laid out on the row's own
   * grid so each lines up with the sortable header above it. Pair with
   * `gridTemplate`.
   */
  gridCells?: ReactNode
  gridTemplate?: string
  /** Right-aligned detail beside the status glyphs, in columns view. */
  meta?: ReactNode
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
  onDoubleClick?: (event: MouseEvent<HTMLElement>) => void
  /** The column's key table (`useFinderKeyboard`), already bound to this row. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onOpen?: () => void
  /** The click that selects. Opening is the double-click, Enter or a chevron. */
  onSelect?: (event: MouseEvent<HTMLElement>) => void
  /** `prewarmRowHandlers(prewarm, to)` for a row that navigates. */
  prewarm?: RowProps['prewarm']
  /**
   * Set while this row is being renamed: the name becomes a field in place,
   * and the row stops being a control until it commits or reverts. Handed in
   * by `useFinderMenus().rowProps(row)` together with `onContextMenu`, so a
   * column spreads one bag rather than threading two unrelated props.
   */
  rename?: FinderRowRename
  kind?: 'folder' | 'document' | 'file' | 'space' | 'virtual' | 'link'
  selected?: boolean
  /** How many people the page is shared with; 0 or absent shows nothing. */
  shareCount?: number
  subtitle?: ReactNode
  tabIndex?: number
  title: string
  /** Extra trailing content before the status glyphs: a badge, a pill. */
  trailing?: ReactNode
  /** Live cross-space move or copy: the row is read-only until it lands. */
  transfer?: 'move' | 'copy' | null
  upload?: FinderRowUpload
  variant: FinderRowVariant
}

const glyph = (icon: IconDefinition, tone: string, title?: string) => (
  <FontAwesomeIcon
    className="h-3.5 w-3.5 shrink-0"
    icon={icon}
    style={{ color: `var(${tone})` }}
    title={title}
  />
)

/**
 * One glyph, and only when there is something to say — read from the single
 * derivation in `indexing-copy.ts` so the row, Get Info and the upload tray
 * cannot describe the same state in three vocabularies. Nothing is painted for
 * `indexed`: a quiet row is the point, and a tick on every row of a folder
 * says only that the folder exists. A draft is quiet too — a document is
 * chunked on publish, not on save, so a spinner there could never resolve.
 */
const IndexingGlyph = ({
  filename,
  indexing,
}: {
  /** A file node's name, so an unsupported type can name its family. */
  filename?: string
  indexing: KnowledgeIndexingState
}) => {
  const copy = indexingCopy(
    indexing,
    filename ? familyLabel[familyForFilename(filename)] : undefined,
  )
  if (copy.glyph === 'none' || !copy.icon) return null
  return (
    <FontAwesomeIcon
      aria-label={copy.sentence}
      className={[
        'h-3.5 w-3.5 shrink-0',
        copy.spin ? 'animate-spin' : '',
        `text-[color:var(${copy.tone})]`,
      ].filter(Boolean).join(' ')}
      icon={copy.icon}
      title={copy.sentence}
    />
  )
}

const UploadLine = ({ upload }: { upload: FinderRowUpload }) =>
  upload.error ? (
    <span className="text-xs text-[color:var(--danger-text)]">{upload.error}</span>
  ) : (
    <span className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
      {upload.label ?? 'Uploading…'}
      {upload.pct === undefined ? null : (
        <span className="block h-1 w-16 overflow-hidden rounded-full bg-[color:var(--overlay)]">
          <span
            className="block h-full rounded-full bg-[color:var(--accent)]"
            style={{ width: `${Math.min(100, Math.max(0, upload.pct))}%` }}
          />
        </span>
      )}
    </span>
  )

export const FinderRow = ({
  ariaLabel,
  chevron = false,
  columnActive = true,
  disabled = false,
  dragHandlers,
  draggable,
  dragging,
  dropTarget,
  elementRef,
  gridCells,
  gridTemplate,
  icon,
  iconTone = '--tx3',
  id,
  indexing,
  kind,
  leading,
  locked = false,
  meta,
  onContextMenu,
  onDoubleClick,
  onKeyDown,
  onOpen,
  onSelect,
  prewarm,
  rename,
  selected = false,
  shareCount = 0,
  subtitle,
  tabIndex,
  title,
  trailing,
  transfer,
  upload,
  variant,
}: FinderRowProps) => {
  const transferring = Boolean(transfer)

  // A row being renamed is a field, not a control: it must not stay clickable,
  // draggable or selectable underneath the editor, and the editor keeps the
  // row's place in the list so nothing below it moves.
  if (rename) {
    return <RenameRow {...rename} icon={icon} iconTone={iconTone} title={title} />
  }

  const leadingNode = leading ?? (icon
    ? (
      <span className="relative flex h-4 w-4 items-center justify-center">
        <FontAwesomeIcon
          className="h-3.5 w-3.5"
          fixedWidth
          icon={icon}
          style={{ color: `var(${iconTone})` }}
        />
        {locked ? (
          // A folder somebody shared read-only. The badge sits on the glyph
          // rather than in the trailing lane because it is a property of the
          // folder, not a thing the row can tell you about itself.
          <FontAwesomeIcon
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 text-[color:var(--tx3)]"
            icon={faLock}
            title="You can read this folder but not change it"
          />
        ) : null}
      </span>
    )
    : null)

  return (
    <Row
      ariaLabel={ariaLabel}
      ariaSelected={selected}
      columnActive={columnActive}
      data={{
        'data-finder-row': id,
        'data-finder-variant': variant,
        ...(kind ? { 'data-finder-kind': kind } : {}),
        ...(kind === 'folder' || variant === 'root' ? { 'data-finder-folder': 'true' } : {}),
      }}
      disabled={disabled || transferring}
      dragHandlers={dragHandlers}
      draggable={draggable && !transferring}
      dragging={dragging}
      dropTarget={dropTarget}
      elementRef={elementRef}
      gridCells={gridCells}
      gridTemplate={gridTemplate}
      leading={leadingNode}
      onClick={(event) => {
        if (disabled) return
        if (onSelect) onSelect(event)
        // A root row and a folder open on the single click that selects them,
        // which is this browser's whole gesture; an item waits for Enter or a
        // double-click so a selection can be extended without opening five
        // documents on the way.
        if (onOpen && (variant === 'root' || kind === 'folder')) onOpen()
      }}
      onContextMenu={onContextMenu}
      onDoubleClick={(event) => {
        onDoubleClick?.(event)
        if (!disabled && onOpen) onOpen()
      }}
      onKeyDown={onKeyDown}
      prewarm={prewarm}
      role="option"
      selected={selected}
      selectionStyle="pill"
      size="finder"
      subtitle={
        upload ? <UploadLine upload={upload} />
          : transferring
            ? (
              <span className="text-xs text-[color:var(--tx3)]">
                {transfer === 'copy' ? 'Copying…' : 'Moving…'}
              </span>
            )
            : subtitle
      }
      tabIndex={tabIndex}
      title={
        <MiddleTruncate
          className={transferring ? 'opacity-60' : undefined}
          text={title}
        />
      }
      trailing={
        <>
          {meta ? (
            <span className="finder-row-meta shrink-0 text-xs text-[color:var(--tx3)]">{meta}</span>
          ) : null}
          {trailing}
          {shareCount > 0
            ? glyph(
              faUserGroup,
              '--tx3',
              `Shared with ${shareCount} ${shareCount === 1 ? 'person' : 'people'}`,
            )
            : null}
          {indexing ? (
            <IndexingGlyph
              filename={kind === 'file' ? title : undefined}
              indexing={indexing}
            />
          ) : null}
          {chevron ? (
            <FontAwesomeIcon
              className="finder-row-chevron h-3 w-3 shrink-0 text-[color:var(--tx3)]"
              icon={faChevronRight}
            />
          ) : null}
        </>
      }
    />
  )
}
