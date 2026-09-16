import {
  faArrowDownWideShort,
  faFileArrowUp,
  faFileLines,
  faFolderPlus,
  faGear,
  faPlus,
} from '@fortawesome/free-solid-svg-icons'
import type {
  PageHeaderAction,
  PageHeaderMenuItem,
} from '../../../shared/ResponsivePageHeader'
import {
  composeFinderSort,
  FINDER_SORT_LABELS,
  finderSortDirection,
  finderSortKey,
  type FinderSort,
  type FinderSortKey,
} from './finder-sort'
import { finderViewOptions, type FinderView } from './finder-view'

/**
 * Every header action the Finder has (browser-ui.md §6), in one place.
 *
 * It replaces `knowledge-workspace-actions.ts`, and it re-homes rather than
 * drops: `View`, `Needs review (n)`, `Open agent`, `Upload file`, `New
 * folder`, `New page` and the ⚙ all still exist. Upload moved inside New
 * file's menu (the owner's word is "file", and "Document or Upload" is one
 * decision, not two buttons), and New page became New file → Document.
 *
 * `ResponsivePageHeader` measures these and moves the lowest priorities into
 * More, so a narrow project tab needs no rules of its own.
 *
 * **One primary: New file.** Creating the thing the screen lists is always
 * the primary, and two filled buttons name no decision.
 */

export type FinderToolbarInput = {
  /** Drafts awaiting review in the active space; 0 hides the filter. */
  agentDraftCount: number
  /** The active column can be written to: not virtual, and its space allows it. */
  canWrite: boolean
  /** The active space has something to manage — visibility, members. */
  canManageSpace: boolean
  /** True at the root column, where New folder means a whole new root folder. */
  isRootColumn: boolean
  /** Latest and Shared with me are ordered by time; Sort has nothing to say. */
  isVirtualColumn: boolean
  needsReviewOnly: boolean
  onCreateDocument: () => void
  onCreateFolder: () => void
  onOpenAgent: (agentId: string) => void
  onOpenSettings: () => void
  onSelectSort: (sort: FinderSort) => void
  onSelectView: (view: FinderView) => void
  onToggleNeedsReview: (checked: boolean) => void
  onUploadFile: () => void
  ownerAgentId?: string | null
  /** The agent whose own page this is, so it does not offer to open itself. */
  scopeAgentId?: string
  /** Omitted on `single`, where a column *is* a list. */
  showViewAction: boolean
  sort: FinderSort
  view: FinderView
}

const SORT_KEYS: FinderSortKey[] = ['name', 'modified', 'created', 'size', 'kind']

const sortMenuItems = (
  sort: FinderSort,
  onSelectSort: (next: FinderSort) => void,
): PageHeaderMenuItem[] => {
  const key = finderSortKey(sort)
  const direction = finderSortDirection(sort)
  return [
    ...SORT_KEYS.map((candidate): PageHeaderMenuItem => ({
      checked: candidate === key,
      id: `sort-${candidate}`,
      label: FINDER_SORT_LABELS[candidate],
      // Re-picking the key you are on flips the direction, which is what a
      // column header does and what a person expects from a sort menu.
      onSelect: () =>
        onSelectSort(
          candidate === key
            ? composeFinderSort(candidate, direction === 'asc' ? 'desc' : 'asc')
            : composeFinderSort(candidate, 'asc'),
        ),
    })),
    {
      checked: direction === 'asc',
      id: 'sort-ascending',
      label: 'Ascending',
      onSelect: () => onSelectSort(composeFinderSort(key, 'asc')),
    },
    {
      checked: direction === 'desc',
      id: 'sort-descending',
      label: 'Descending',
      onSelect: () => onSelectSort(composeFinderSort(key, 'desc')),
    },
  ]
}

export const buildFinderToolbarActions = (input: FinderToolbarInput): PageHeaderAction[] => {
  const writable = input.canWrite && !input.isVirtualColumn
  const selectedView = finderViewOptions.find((option) => option.value === input.view)
  const ownerAgentId = input.ownerAgentId

  return [
    ...(writable
      ? [{
          icon: faPlus,
          id: 'new-file',
          items: [
            {
              icon: faFileLines,
              id: 'new-document',
              label: 'Document',
              onSelect: input.onCreateDocument,
            },
            {
              icon: faFileArrowUp,
              id: 'upload-file',
              label: 'Upload…',
              onSelect: input.onUploadFile,
            },
          ],
          kind: 'menu',
          label: 'New file',
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction]
      : []),
    ...(writable || input.isRootColumn
      ? [{
          icon: faFolderPlus,
          id: 'new-folder',
          // At the root there is no folder to create a folder *in*: the row
          // you would be adding is a whole root folder, which needs a
          // visibility choice an inline name field cannot carry.
          label: input.isRootColumn ? 'New shared folder…' : 'New folder',
          onSelect: input.onCreateFolder,
          priority: 90,
        } satisfies PageHeaderAction]
      : []),
    {
      disabled: input.isVirtualColumn,
      icon: faArrowDownWideShort,
      id: 'sort',
      items: sortMenuItems(input.sort, input.onSelectSort),
      kind: 'menu',
      label: `Sort: ${FINDER_SORT_LABELS[finderSortKey(input.sort)]}`,
      priority: 80,
      title: input.isVirtualColumn
        ? 'Latest and Shared with me are ordered by time'
        : 'Choose how this folder is ordered',
    },
    ...(input.showViewAction
      ? [{
          icon: selectedView?.icon,
          id: 'view',
          items: finderViewOptions.map((option) => ({
            checked: option.value === input.view,
            icon: option.icon,
            id: option.value,
            label: option.label,
            onSelect: () => input.onSelectView(option.value),
            title: option.title,
          })),
          kind: 'menu',
          label: `View: ${selectedView?.label ?? 'Columns'}`,
          priority: 70,
        } satisfies PageHeaderAction]
      : []),
    ...(input.agentDraftCount > 0 || input.needsReviewOnly
      ? [{
          checked: input.needsReviewOnly,
          id: 'needs-review',
          kind: 'toggle',
          label: `Needs review (${input.agentDraftCount})`,
          onChange: input.onToggleNeedsReview,
          priority: 60,
        } satisfies PageHeaderAction]
      : []),
    ...(ownerAgentId && ownerAgentId !== input.scopeAgentId
      ? [{
          id: 'open-agent',
          label: 'Open agent',
          onSelect: () => input.onOpenAgent(ownerAgentId),
          priority: 50,
        } satisfies PageHeaderAction]
      : []),
    ...(input.canManageSpace
      ? [{
          compact: true,
          icon: faGear,
          id: 'sharing-settings',
          label: 'Sharing & settings',
          onSelect: input.onOpenSettings,
          priority: 10,
        } satisfies PageHeaderAction]
      : []),
  ]
}
