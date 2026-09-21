import { useCallback, useEffect, useState } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import { faColumns, faList, faSitemap, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { getCookie, getStoredJson, setStoredJson } from '../../../../lib/storage'
import type { ColumnResizeConfig } from '../../../shared/column-browser/ColumnBrowserColumn'

/**
 * What the URL says the browser is showing: which view, and which folder.
 *
 * Three view modes: tree, columns and list.
 *
 * `column` becomes `columns`; `full` *is* `list`, so it keeps the rows and
 * loses the name. Tree is the guided all-folders view and the first-class
 * entry in the Finder view switcher.
 */
export const FINDER_VIEWS = ['tree', 'columns', 'list'] as const

export type FinderView = (typeof FINDER_VIEWS)[number]

export const DEFAULT_FINDER_VIEW: FinderView = 'columns'

export const FINDER_VIEW_COOKIE = 'knowledgeViewMode'

export const isFinderView = (value: string | null | undefined): value is FinderView =>
  FINDER_VIEWS.some((view) => view === value)

/**
 * The cookie is shared with the vocabulary it had before, because a person who
 * chose "Column" last week must not be handed the default this week. A stored
 * value is read through this once and migrated to the current view vocabulary.
 */
export const migrateStoredFinderView = (stored: string | null | undefined): FinderView => {
  if (isFinderView(stored)) return stored
  switch (stored) {
    case 'column':
      return 'columns'
    case 'full':
      return 'list'
    default:
      return DEFAULT_FINDER_VIEW
  }
}

export const finderViewOptions: Array<{
  icon: IconDefinition
  label: string
  title: string
  value: FinderView
}> = [
  {
    icon: faSitemap,
    label: 'Tree',
    title: 'Browse all folders in one guided tree',
    value: 'tree',
  },
  {
    icon: faColumns,
    label: 'Columns',
    title: 'Browse folders in sliding columns',
    value: 'columns',
  },
  {
    icon: faList,
    label: 'List',
    title: 'One folder at a time, with size, date and kind',
    value: 'list',
  },
]

type FolderParamInput = {
  browseTo: (path: string[]) => void
  pageById: (pageId: string) => KnowledgePageRecord | undefined
  pagePath: string[]
  pagesLoading: boolean
  searchParams: URLSearchParams
  selectedSpaceId?: string
  setSearchParams: SetURLSearchParams
}

/**
 * `?folder=<pageId>` — the deepest open folder.
 *
 * It is **read before it is written**. The mirror would otherwise delete the
 * param on the first render, because the path is empty until the space's pages
 * arrive, and a cold start would land at the root with the link it was given
 * already gone. So the seed runs once per space, and the mirror waits for it.
 *
 * Rebuilding the path is a walk up `parentPageId`: the space's page list is
 * loaded whole, so it costs no request. A folder id that is not in this space
 * simply reads as the root.
 *
 * The mirror writes with `replace`: which folder is open is part of what the
 * screen currently shows, not a place Back should walk through
 * (docs/navigation/overview.md §1).
 *
 * **`?folder=` is a folder, and only a folder.** The browse path also carries
 * the open page as its last entry, so mirroring `pagePath.at(-1)` wrote a
 * document's id into the param — a link that means "browse *into* this
 * document". Followed cold, on a phone, it seeded an empty column named after
 * the document and `browseTo` cleared the open page on the way, so every
 * `?pageId=` deep link landed on "Nothing here yet" instead of the page. The
 * mirror therefore names the deepest entry that is actually a folder, and the
 * seed refuses to re-browse a folder that is already open, because doing so
 * closes whatever is open inside it.
 */
export const useFinderFolderParam = ({
  browseTo,
  pageById,
  pagePath,
  pagesLoading,
  searchParams,
  selectedSpaceId,
  setSearchParams,
}: FolderParamInput): void => {
  const folderParam = searchParams.get('folder')
  const [seeded, setSeeded] = useState(false)

  useEffect(() => setSeeded(false), [selectedSpaceId])

  // The deepest entry of the browse path that is a folder; `null` at a space's
  // root. Never the open page, whatever its kind.
  const openFolder = (() => {
    for (let index = pagePath.length - 1; index >= 0; index -= 1) {
      const id = pagePath[index]
      if (id && pageById(id)?.kind === 'folder') return id
    }
    return null
  })()

  useEffect(() => {
    if (seeded) return
    if (!folderParam) {
      setSeeded(true)
      return
    }
    // Wait for a space *and* its pages. Treating "no space yet" as nothing to
    // do is what made a cold `?folder=` link land at the root: the route's own
    // effect has not chosen the space on the first render, so the seed gave up
    // one frame before the thing it needed arrived.
    if (!selectedSpaceId || pagesLoading) return
    setSeeded(true)
    const target = pageById(folderParam)
    if (!target) return
    const path: string[] = []
    const visited = new Set<string>()
    let current: KnowledgePageRecord | undefined = target
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      path.unshift(current.id)
      current = current.parentPageId ? pageById(current.parentPageId) : undefined
    }
    // Already standing in it — a deep link that opened a page inside this
    // folder has the same prefix. `browseTo` closes the open page, so seeding
    // here would undo the thing the link was for.
    if (path.every((id, index) => pagePath[index] === id)) return
    browseTo(path)
  }, [browseTo, folderParam, pageById, pagePath, pagesLoading, seeded, selectedSpaceId])

  useEffect(() => {
    if (!seeded) return
    // Nothing is known about any id until the space's pages arrive, so the
    // walk above would answer `null` and delete a param it is about to need.
    if (pagesLoading) return
    const open = openFolder
    if ((folderParam ?? null) === open) return
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (open) params.set('folder', open)
        else params.delete('folder')
        return params
      },
      { replace: true },
    )
  }, [folderParam, openFolder, pagesLoading, seeded, setSearchParams])
}

/**
 * What the Finder's bar is titled. Finder names the window after the folder
 * you are standing in, not after the app — which is also what keeps the bar
 * and the root column from saying the same word twice.
 */
export const finderBarTitle = ({
  deepestFolderTitle,
  spaceName,
  virtualKind,
}: {
  deepestFolderTitle: string | undefined
  spaceName: string | undefined
  virtualKind: 'latest' | 'shared-with-me' | null
}): string => {
  if (virtualKind === 'latest') return 'Latest'
  if (virtualKind === 'shared-with-me') return 'Shared with me'
  return deepestFolderTitle ?? spaceName ?? 'Documents'
}


// ── Column widths ───────────────────────────────────────────────────────────
//
// The other half of "what the browser is showing". Every separator is
// resizable and each column's width is its own, keyed by the column's *slot*
// — root, the virtual listing, depth:0, depth:1, … — never by page or space
// id: "the second column is too narrow" is about the position, and a map that
// grew a key per folder anybody ever opened would be a leak. The set is one
// JSON object in localStorage; the retired single-width cookie is read once
// as the starting width for people who already sized their columns, then the
// store owns it. Every value comes back through the clamp, so a hand-edited
// store cannot produce a 4px column.

export const FINDER_COLUMN_WIDTH_COOKIE = 'knowledgeColumnWidth'
export const FINDER_COLUMN_WIDTHS_KEY = 'nessie.admin.knowledgeColumnWidths'
export const MIN_COLUMN_WIDTH = 300
export const MAX_COLUMN_WIDTH = 720
export const DEFAULT_COLUMN_WIDTH = 320

export const clampColumnWidth = (value: number): number =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value))

/** The slots a width can be stored under: a position, never a folder's id. */
export type FinderColumnSlot = 'root' | 'virtual' | `depth:${number}`

export type FinderColumnWidths = Partial<Record<FinderColumnSlot, number>>

const FINDER_COLUMN_SLOT = /^(?:root|virtual|depth:\d+)$/

/** The parsed store, with junk keys and out-of-range values already dropped. */
export const parseFinderColumnWidths = (parsed: unknown): FinderColumnWidths => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const widths: FinderColumnWidths = {}
  for (const [slot, value] of Object.entries(parsed)) {
    if (!FINDER_COLUMN_SLOT.test(slot)) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    widths[slot as FinderColumnSlot] = clampColumnWidth(value)
  }
  return widths
}

/** The stored map, tolerating a blocked store and a hand-edited one. */
export const readFinderColumnWidths = (): FinderColumnWidths =>
  parseFinderColumnWidths(getStoredJson(FINDER_COLUMN_WIDTHS_KEY))

/** One slot's width merged into the map, for the commit write. */
export const withFinderColumnWidth = (
  widths: FinderColumnWidths,
  slot: FinderColumnSlot,
  width: number,
): FinderColumnWidths => ({ ...widths, [slot]: clampColumnWidth(width) })

/**
 * What a slot renders at: its live (not yet committed) drag width, else its
 * stored width, else the legacy cookie's single width — the migration's
 * starting point — which itself defaults to `DEFAULT_COLUMN_WIDTH`.
 */
export const resolveFinderColumnWidth = (
  stored: FinderColumnWidths,
  live: FinderColumnWidths,
  legacyWidth: number,
  slot: FinderColumnSlot,
): number => live[slot] ?? stored[slot] ?? legacyWidth

/** The retired single-width cookie, kept only as the migration's starting point. */
const readLegacyColumnWidth = (): number => {
  const stored = Number(getCookie(FINDER_COLUMN_WIDTH_COOKIE))
  return Number.isFinite(stored) && stored > 0 ? clampColumnWidth(stored) : DEFAULT_COLUMN_WIDTH
}

/** Per-slot widths, and each column's resize-handle contract. */
export const useFinderColumnWidths = () => {
  // The persisted half is read once; from the first drag the live map wins,
  // and a commit re-reads the store before writing so two tabs cannot
  // clobber each other's other slots.
  const [stored] = useState(readFinderColumnWidths)
  const [legacyWidth] = useState(readLegacyColumnWidth)
  const [live, setLive] = useState<FinderColumnWidths>({})

  const widthFor = useCallback(
    (slot: FinderColumnSlot): number =>
      resolveFinderColumnWidth(stored, live, legacyWidth, slot),
    [legacyWidth, live, stored],
  )

  const resizeFor = useCallback(
    (slot: FinderColumnSlot): ColumnResizeConfig => ({
      max: MAX_COLUMN_WIDTH,
      min: MIN_COLUMN_WIDTH,
      // Committed on release, not on every pixel: a localStorage write per
      // mousemove is a localStorage write per mousemove.
      onResize: (next, commit) => {
        setLive((current) => ({ ...current, [slot]: next }))
        if (commit) {
          setStoredJson(
            FINDER_COLUMN_WIDTHS_KEY,
            withFinderColumnWidth(readFinderColumnWidths(), slot, next),
          )
        }
      },
      width: widthFor(slot),
    }),
    [widthFor],
  )

  return { resizeFor, widthFor }
}
