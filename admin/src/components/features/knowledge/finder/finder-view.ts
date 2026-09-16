import { faColumns, faList, type IconDefinition } from '@fortawesome/free-solid-svg-icons'

/**
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
