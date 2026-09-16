import type { ReactNode } from 'react'
import { StorageUsageMeter } from '../StorageUsageMeter'

/**
 * The strip under the columns (browser-ui.md §2) — the one Finder itself uses
 * for "12 items, 3.2 GB available". Item count on the left, organisation
 * storage on the right.
 *
 * The storage meter used to live at the bottom of the navy Knowledge sidebar.
 * That sidebar is gone, and a capacity read that only exists on a screen
 * nobody can reach is Rule zero's defect, so it moved here — the same place,
 * in the same corner, of the screen that replaced it.
 *
 * Hidden on `single`: an item count is not worth 28px on a screen showing one
 * column, and storage moves to Get Info on My Documents there.
 */

type FinderStatusBarProps = {
  /** The upload queue docks here while it is running (Wave 2). */
  children?: ReactNode
  /** Rows in the active column. */
  itemCount: number
  /** Selected rows in the active column; 0 says nothing. */
  selectedCount?: number
  /** A virtual column has read a page of an unknown total. */
  more?: boolean
  /** Organisation scope only: a project tab has no organisation quota to show. */
  showStorage: boolean
  /** More readable folders than the root read; the person should know. */
  truncated?: boolean
}

const itemLine = (
  itemCount: number,
  selectedCount: number,
  more: boolean,
  truncated: boolean,
): string => {
  const items = `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`
  const parts = [more ? `Showing ${items} of more` : items]
  if (selectedCount > 0) parts.push(`${selectedCount} selected`)
  if (truncated) parts.push('more folders than shown')
  return parts.join(', ')
}

export const FinderStatusBar = ({
  children,
  itemCount,
  more = false,
  selectedCount = 0,
  showStorage,
  truncated = false,
}: FinderStatusBarProps) => (
  <div className="finder-status-bar text-xs" data-finder-status-bar>
    <span className="min-w-0 truncate">
      {itemLine(itemCount, selectedCount, more, truncated)}
    </span>
    {children ? <span className="min-w-0 flex-1">{children}</span> : null}
    {showStorage ? <StorageUsageMeter /> : null}
  </div>
)
