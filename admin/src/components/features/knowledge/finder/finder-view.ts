import { useCallback, useEffect, useState } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import { faColumns, faList, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { getCookie, setCookie } from '../../../../lib/storage'

/**
 * What the URL says the browser is showing: which view, and which folder.
 *
 * Two view modes, not three (browser-ui.md §6, overview decision 8).
 *
 * `column` becomes `columns`; `full` *is* `list`, so it keeps the rows and
 * loses the name; `tree` retires — it was a sidebar affordance, and with the
 * sidebar gone and columns doing the drilling, a third way to expand a folder
 * is the fork Rule zero names.
 */
export const FINDER_VIEWS = ['columns', 'list'] as const

export type FinderView = (typeof FINDER_VIEWS)[number]

export const DEFAULT_FINDER_VIEW: FinderView = 'columns'

export const FINDER_VIEW_COOKIE = 'knowledgeViewMode'

export const isFinderView = (value: string | null | undefined): value is FinderView =>
  FINDER_VIEWS.some((view) => view === value)

/**
 * The cookie is shared with the vocabulary it had before, because a person who
 * chose "Column" last week must not be handed the default this week. A stored
 * value is read through this once, and the *new* word is written back on the
 * first change — a `?view=tree` link degrades the same way, through
 * `useTabParam`'s unknown-value fallback.
 */
export const migrateStoredFinderView = (stored: string | null | undefined): FinderView => {
  if (isFinderView(stored)) return stored
  switch (stored) {
    case 'column':
      return 'columns'
    case 'full':
    case 'tree':
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


// ── Column width ────────────────────────────────────────────────────────────
//
// The other half of "what the browser is showing", and persisted the same way:
// one width for every column, in a cookie, so a person who widened the columns
// on Monday finds them wide on Tuesday. It lives here rather than in
// `DocumentsFinder` because it is view state and nothing else, and it is read
// back through the clamp so a hand-edited cookie cannot produce a 4px column.

export const FINDER_COLUMN_WIDTH_COOKIE = 'knowledgeColumnWidth'
export const MIN_COLUMN_WIDTH = 300
export const MAX_COLUMN_WIDTH = 720
export const DEFAULT_COLUMN_WIDTH = 320

export const clampColumnWidth = (value: number): number =>
  Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value))

const readStoredWidth = (): number => {
  const stored = Number(getCookie(FINDER_COLUMN_WIDTH_COOKIE))
  return Number.isFinite(stored) && stored > 0 ? clampColumnWidth(stored) : DEFAULT_COLUMN_WIDTH
}

/** The live width, and the resize handle's contract, for every column. */
export const useFinderColumnWidth = () => {
  const [width, setWidth] = useState(readStoredWidth)
  // Committed on release, not on every pixel: a cookie write per mousemove is
  // a cookie write per mousemove.
  const onResize = useCallback((next: number, commit: boolean) => {
    setWidth(next)
    if (commit) setCookie(FINDER_COLUMN_WIDTH_COOKIE, String(next))
  }, [])
  return { columnWidth: width, resize: { max: MAX_COLUMN_WIDTH, min: MIN_COLUMN_WIDTH, onResize, width } }
}
