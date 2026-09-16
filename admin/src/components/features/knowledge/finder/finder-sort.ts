import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import {
  familyForFilename,
  familyLabel,
  type FileFamily,
} from '../../../shared/file-icons'

/**
 * The Finder's ordering (browser-ui.md §6). Direction is folded into the key
 * so `?sort=` is one value and the menu is one radio group: ten strings, not a
 * key plus a direction that can disagree with each other in a URL.
 */
export const FINDER_SORTS = [
  'name', 'name-desc',
  'modified', 'modified-desc',
  'created', 'created-desc',
  'size', 'size-desc',
  'kind', 'kind-desc',
] as const

export type FinderSort = (typeof FINDER_SORTS)[number]

export type FinderSortKey = 'name' | 'modified' | 'created' | 'size' | 'kind'

export type FinderSortDirection = 'asc' | 'desc'

export const DEFAULT_FINDER_SORT: FinderSort = 'name'

export const FINDER_SORT_COOKIE = 'knowledgeSort'

export const isFinderSort = (value: string | null | undefined): value is FinderSort =>
  FINDER_SORTS.some((sort) => sort === value)

export const finderSortKey = (sort: FinderSort): FinderSortKey =>
  sort.replace(/-desc$/, '') as FinderSortKey

export const finderSortDirection = (sort: FinderSort): FinderSortDirection =>
  sort.endsWith('-desc') ? 'desc' : 'asc'

export const composeFinderSort = (
  key: FinderSortKey,
  direction: FinderSortDirection,
): FinderSort => (direction === 'desc' ? (`${key}-desc` as FinderSort) : (key as FinderSort))

export const FINDER_SORT_LABELS: Record<FinderSortKey, string> = {
  name: 'Name',
  modified: 'Date modified',
  created: 'Date created',
  size: 'Size',
  kind: 'Kind',
}

/**
 * Which family a row belongs to, for its glyph's tone and for Sort by kind.
 *
 * The switch is exhaustive over `KnowledgePageKind`: a kind added later (a
 * spreadsheet, say) fails to compile here until it names its family, rather
 * than silently rendering as a grey blank page with the Kind "File".
 */
export const familyForRow = (page: {
  kind: KnowledgePageRecord['kind']
  title: string
}): FileFamily => {
  switch (page.kind) {
    case 'folder':
      return 'folder'
    case 'document':
      return 'document'
    case 'file':
      return familyForFilename(page.title)
    default: {
      const exhaustive: never = page.kind
      return exhaustive
    }
  }
}

export const kindLabelForRow = (page: {
  kind: KnowledgePageRecord['kind']
  title: string
}): string => familyLabel[familyForRow(page)]

type SortableRow = Pick<
  KnowledgePageRecord,
  'id' | 'kind' | 'title' | 'position' | 'createdAt' | 'updatedAt'
> & { sizeBytes?: string | null }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const byTime = (value: string): number => {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

// Folders and documents have no byte count of their own until the server joins
// one on, and `null` must not sort as zero: an unknown size goes last in both
// directions, the way an unsized row does in Finder.
const bySize = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Folders first, always. Finder calls it "keep folders on top" and offers a
 * switch; we do not, because the switch is one more piece of state that has to
 * be stored, migrated and explained, to arrange a list two ways that both work.
 *
 * Within a group the key decides, and every comparison falls through to
 * `position` and then `id` so the order is total — an unstable tail is what
 * makes a list appear to shuffle when a single row's `updatedAt` ticks.
 */
export const sortFinderRows = <T extends SortableRow>(rows: T[], sort: FinderSort): T[] => {
  const key = finderSortKey(sort)
  const descending = finderSortDirection(sort) === 'desc'

  return [...rows].sort((left, right) => {
    const leftFolder = left.kind === 'folder'
    const rightFolder = right.kind === 'folder'
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1

    let comparison = 0
    switch (key) {
      case 'name':
        comparison = collator.compare(left.title, right.title)
        break
      case 'modified':
        comparison = byTime(left.updatedAt) - byTime(right.updatedAt)
        break
      case 'created':
        comparison = byTime(left.createdAt) - byTime(right.createdAt)
        break
      case 'size': {
        const leftSize = bySize(left.sizeBytes)
        const rightSize = bySize(right.sizeBytes)
        if (leftSize === null || rightSize === null) {
          // Nulls last in both directions, so the caller's `descending` flip
          // below must not reach them.
          comparison = leftSize === rightSize ? 0 : leftSize === null ? 1 : -1
          return comparison || left.position - right.position || left.id.localeCompare(right.id)
        }
        comparison = leftSize - rightSize
        break
      }
      case 'kind':
        comparison = collator.compare(kindLabelForRow(left), kindLabelForRow(right))
          || collator.compare(left.title, right.title)
        break
    }

    if (descending) comparison = -comparison
    return comparison || left.position - right.position || left.id.localeCompare(right.id)
  })
}

/**
 * "3 Sep 2026 14:02" — list view's Date modified cell and the tooltip on a
 * row's date. There is no shared `formatDateTime` in the admin to reuse; this
 * is the one place the Finder needs one, so it is declared beside the ordering
 * that reads the same field rather than added to `lib/` for a single caller.
 */
export const formatFinderDate = (value: string): string => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
