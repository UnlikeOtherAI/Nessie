import { useEffect, useMemo, useState } from 'react'
import { faChevronDown, faChevronRight, faFolder } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeRoot } from '@nessie/schemas'
import { useKnowledgePages, type KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { useMovePages, useTransferPages } from '../../../../facades/knowledge/finder-hooks'
import { Dialog } from '../../../shared/Dialog'
import { FormActions } from '../../../shared/FormActions'
import { TransferConsequenceLines, type TransferRefusal } from './TransferPrompt'
import {
  destinationsFromRoot,
  moveToDialogTitle,
  transferRefusalSentence,
  type TransferDestination,
} from './transfer-copy'

/**
 * Move to… — the keyboard and menu doorway to the same two operations the drag
 * offers (menus-and-dialogs.md §7, transfer.md §1).
 *
 * The tree lists **every root folder the person can write**, not just the one
 * the item is in, which is what makes a cross-root move reachable without a
 * drag at all. Picking a target in the item's own root keeps the one primary
 * "Move". Picking a target in another root swaps the footer to two secondaries
 * and no primary — a footer with two filled buttons would name no decision, and
 * here there genuinely are two — and the audience and sharing lines appear
 * above it, exactly as the drop-point menu shows them.
 *
 * One root is expanded at a time: its folders are one query, and a dialog that
 * fans out a page list per root folder on open is a dialog that opens slowly on
 * the account that needs it most.
 */

export type MoveToDialogProps = {
  open: boolean
  onClose: () => void
  /** The rows being moved, in selection order. */
  pages: KnowledgePageRecord[]
  /** The root folder they are in now. */
  sourceSpaceId: string
  /** The folder they are in now; `null` is that root's own listing. */
  currentParentPageId: string | null
  root: KnowledgeRoot | undefined
  /** The source column's rows, for the "into itself" walk. */
  pageById: (pageId: string) => KnowledgePageRecord | undefined
}

type Target = { spaceId: string; parentPageId: string | null }

type TreeRow = {
  id: string
  depth: number
  title: string
  parentPageId: string | null
  disabled?: string
}

// Hover paint is withheld in JS rather than with a CSS guard: the admin's
// unlayered `button { font: inherit }` reset is the standing proof that an
// unlayered rule outranks a layered utility, so a row that carries no hover
// class at all is the only row a stylesheet cannot repaint.
const rowClass = (disabled: boolean): string =>
  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pr-2 text-left'
  + (disabled ? ' cursor-default' : ' hover:bg-[color:var(--overlay)]')

/** Every folder under `spaceId`, as rows with a depth, parents before children. */
const folderRows = (
  pages: KnowledgePageRecord[],
  blocked: (pageId: string) => string | undefined,
): TreeRow[] => {
  const folders = pages.filter((page) => page.kind === 'folder')
  const byParent = new Map<string | null, KnowledgePageRecord[]>()
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentPageId ?? null) ?? []
    siblings.push(folder)
    byParent.set(folder.parentPageId ?? null, siblings)
  }
  const rows: TreeRow[] = []
  const walk = (parentPageId: string | null, depth: number) => {
    // Depth is capped where the server caps a transfer's subtree; a cycle in
    // the cache would otherwise render forever.
    if (depth > 12) return
    for (const folder of (byParent.get(parentPageId) ?? [])) {
      rows.push({
        depth,
        disabled: blocked(folder.id),
        id: folder.id,
        parentPageId: folder.parentPageId ?? null,
        title: folder.title,
      })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 1)
  return rows
}

export const MoveToDialog = ({
  currentParentPageId,
  onClose,
  open,
  pageById,
  pages,
  root,
  sourceSpaceId,
}: MoveToDialogProps) => {
  const destinations = useMemo(
    () => destinationsFromRoot(root).filter((space) => space.canWrite),
    [root],
  )
  const [expanded, setExpanded] = useState<string | null>(sourceSpaceId)
  const [target, setTarget] = useState<Target | null>(null)
  const [refusal, setRefusal] = useState<TransferRefusal | null>(null)

  // The item's own root is the one open on arrival, and reopening the dialog on
  // a different item must not leave the previous item's root expanded.
  useEffect(() => {
    if (!open) return
    setExpanded(sourceSpaceId)
    setTarget(null)
    setRefusal(null)
  }, [open, sourceSpaceId])

  const expandedPages = useKnowledgePages(open && expanded ? expanded : undefined)
  const movePages = useMovePages()
  const transferPages = useTransferPages()

  const movingIds = useMemo(() => new Set(pages.map((page) => page.id)), [pages])
  const blocked = (spaceId: string) => (pageId: string): string | undefined => {
    if (spaceId !== sourceSpaceId) return undefined
    if (movingIds.has(pageId)) return "Can't move a folder into itself"
    let walk = pageById(pageId)
    const seen = new Set<string>()
    while (walk && !seen.has(walk.id)) {
      seen.add(walk.id)
      if (movingIds.has(walk.id)) return "Can't move a folder into itself"
      walk = walk.parentPageId ? pageById(walk.parentPageId) : undefined
    }
    return undefined
  }

  const destination = destinations.find((space) => space.spaceId === target?.spaceId)
  const crossRoot = Boolean(target && target.spaceId !== sourceSpaceId)
  const sameRootMoveReady = Boolean(
    target && !crossRoot && target.parentPageId !== currentParentPageId,
  )
  const sharesEnding = pages.reduce((total, page) => total + (page.shareCount ?? 0), 0)
  const pending = movePages.isPending || transferPages.isPending

  const fail = (error: unknown) => {
    const detail = error as { code?: string; message?: string }
    setRefusal({ code: detail.code, message: detail.message })
  }

  const runMove = () => {
    if (!target) return
    movePages.mutate(
      {
        pageIds: pages.map((page) => page.id),
        parentPageId: target.parentPageId,
        revisions: Object.fromEntries(pages.map((page) => [page.id, page.revision])),
        spaceId: sourceSpaceId,
      },
      { onError: fail, onSuccess: onClose },
    )
  }

  const runTransfer = (operation: 'move' | 'copy') => {
    if (!target) return
    transferPages.mutate(
      { operation, pageIds: pages.map((page) => page.id), sourceSpaceId, target },
      { onError: fail, onSuccess: onClose },
    )
  }

  const rootRow = (space: TransferDestination) => {
    const isOpen = expanded === space.spaceId
    const picked = target?.spaceId === space.spaceId && target.parentPageId === null
    const current = space.spaceId === sourceSpaceId && currentParentPageId === null
    return (
      <li key={space.spaceId}>
        <div className="flex items-center">
          <button
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${space.name}`}
            className="flex h-8 w-6 items-center justify-center text-[color:var(--tx3)]"
            onClick={() => setExpanded(isOpen ? null : space.spaceId)}
            type="button"
          >
            <FontAwesomeIcon
              className="h-3 w-3"
              icon={isOpen ? faChevronDown : faChevronRight}
            />
          </button>
          <button
            aria-current={picked ? 'true' : undefined}
            aria-disabled={current ? true : undefined}
            className={rowClass(current)}
            data-move-target={space.spaceId}
            onClick={() => {
              if (current) return
              setRefusal(null)
              setTarget({ parentPageId: null, spaceId: space.spaceId })
            }}
            title={current ? undefined : `Move into ${space.name}`}
            type="button"
          >
            <FontAwesomeIcon
              className="h-3.5 w-3.5 shrink-0"
              icon={faFolder}
              style={{ color: 'var(--accent)' }}
            />
            <span className={picked
              ? 'min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]'
              : 'min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]'}
            >
              {space.name}
            </span>
            {current ? (
              <span className="shrink-0 text-xs text-[color:var(--tx3)]">(current)</span>
            ) : null}
          </button>
        </div>
        {isOpen ? (
          <ul>
            {folderRows(expandedPages.data ?? [], blocked(space.spaceId)).map((row) => {
              const rowPicked = target?.spaceId === space.spaceId
                && target.parentPageId === row.id
              const rowCurrent = space.spaceId === sourceSpaceId
                && currentParentPageId === row.id
              const off = Boolean(row.disabled) || rowCurrent
              return (
                <li key={row.id}>
                  <button
                    aria-current={rowPicked ? 'true' : undefined}
                    aria-disabled={off ? true : undefined}
                    className={rowClass(off)}
                    data-move-target={row.id}
                    onClick={() => {
                      if (off) return
                      setRefusal(null)
                      setTarget({ parentPageId: row.id, spaceId: space.spaceId })
                    }}
                    style={{ paddingLeft: `${row.depth * 16 + 24}px` }}
                    title={row.disabled}
                    type="button"
                  >
                    <FontAwesomeIcon
                      className={off
                        ? 'h-3.5 w-3.5 shrink-0 opacity-40'
                        : 'h-3.5 w-3.5 shrink-0'}
                      icon={faFolder}
                      style={{ color: 'var(--tx3)' }}
                    />
                    <span className={off
                      ? 'min-w-0 flex-1 truncate text-sm text-[color:var(--tx3)]'
                      : 'min-w-0 flex-1 truncate text-sm text-[color:var(--tx)]'}
                    >
                      {row.title}
                    </span>
                    {rowCurrent ? (
                      <span className="shrink-0 text-xs text-[color:var(--tx3)]">(current)</span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={moveToDialogTitle({ count: pages.length, crossRoot })}
    >
      <div className="grid gap-3">
        <ul className="max-h-[320px] overflow-y-auto" data-move-to-tree>
          {destinations.map(rootRow)}
        </ul>

        {crossRoot && destination ? (
          <TransferConsequenceLines
            count={pages.length}
            destination={destination}
            sharesEnding={sharesEnding}
          />
        ) : null}

        {refusal ? (
          <FormActions>
            <span
              className="min-w-0 flex-1 text-xs text-[color:var(--danger-text)]"
              data-transfer-refusal
            >
              {transferRefusalSentence(refusal.code, refusal.message)}
            </span>
            <button
              className="admin-button admin-button-secondary"
              onClick={() => setRefusal(null)}
              type="button"
            >
              OK
            </button>
          </FormActions>
        ) : (
          <FormActions>
            <button
              className="admin-button admin-button-secondary"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            {crossRoot ? (
              <>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={pending}
                  onClick={() => runTransfer('copy')}
                  type="button"
                >
                  Copy here
                </button>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={pending}
                  onClick={() => runTransfer('move')}
                  type="button"
                >
                  Move here
                </button>
              </>
            ) : (
              <button
                className="admin-button admin-button-primary"
                disabled={!sameRootMoveReady || pending}
                onClick={runMove}
                type="button"
              >
                Move
              </button>
            )}
          </FormActions>
        )}
      </div>
    </Dialog>
  )
}
