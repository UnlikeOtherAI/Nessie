import {
  faArrowDownWideShort,
  faFolderPlus,
  faGear,
  faPlus,
} from '@fortawesome/free-solid-svg-icons'
import type {
  PageHeaderAction,
  PageHeaderButtonAction,
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
import { newFileTypeItems } from './new-file-types'

/**
 * Every header action the Finder's toolbar has (browser-ui.md §6), in one
 * place.
 *
 * It replaces `knowledge-workspace-actions.ts`, and it re-homes rather than
 * drops: `View`, `Needs review (n)`, `Upload file`, `New folder`, `New page`
 * and the ⚙ all still exist. Upload moved inside New file's menu (the
 * owner's word is "file", and "Document or Upload" is one decision, not two
 * buttons), and New page became New file → Document. `Open agent` left the
 * toolbar for the agent column's own header (`buildAgentOpenAction` below):
 * a global bar is the wrong home for a doorway that belongs to one column.
 *
 * `ResponsivePageHeader` measures these and moves the lowest priorities into
 * More, so a narrow project tab needs no rules of its own.
 *
 * **One primary: New file.** Creating the thing the screen lists is always
 * the primary, and two filled buttons name no decision.
 */

/**
 * The `Open` button an agent's documents column carries in its own header.
 * Absent where the space is nobody's agent home, and absent where the column
 * would offer to open the agent whose own page you are already on — the old
 * toolbar action's `scopeAgentId` check, kept for the same reason.
 */
export const buildAgentOpenAction = ({
  onOpenAgent,
  ownerAgentId,
  scopeAgentId,
}: {
  onOpenAgent: (agentId: string) => void
  /** The active space's `ownerAgentId`; anything else means no doorway. */
  ownerAgentId?: string | null
  /** The agent whose own page this is, so it does not offer to open itself. */
  scopeAgentId?: string
}): PageHeaderButtonAction | null =>
  ownerAgentId && ownerAgentId !== scopeAgentId
    ? {
        id: 'open-agent',
        label: 'Open',
        onSelect: () => onOpenAgent(ownerAgentId),
        priority: 0,
        title: 'Open the agent these documents belong to',
      }
    : null

export type FinderToolbarInput = {
  /** Drafts awaiting review in the active space; 0 hides the filter. */
  agentDraftCount: number
  /** The active column can be written to: not virtual, and its space allows it. */
  canWrite: boolean
  /** The active space has something to manage — visibility, members. */
  canManageSpace: boolean
  /** True at the Knowledge root, where New creates a space rather than a folder. */
  isRootColumn: boolean
  /** Latest and Shared with me are ordered by time; Sort has nothing to say. */
  isVirtualColumn: boolean
  needsReviewOnly: boolean
  onCreateDocument: () => void
  onCreateFolder: () => void
  /** Absent where the spreadsheet dialogs are not mounted; the rows are then absent. */
  onCreateSpreadsheet?: () => void
  onImportSpreadsheet?: () => void
  onOpenSettings: () => void
  onSelectSort: (sort: FinderSort) => void
  onSelectView: (view: FinderView) => void
  onToggleNeedsReview: (checked: boolean) => void
  onUploadFile: () => void
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

  return [
    // One New. Folder, document and upload are four words apart, not two
    // buttons apart: a toolbar that asks "which button" before "which kind"
    // makes the person answer the same question twice.
    ...(writable || input.isRootColumn
      ? [{
          icon: faPlus,
          id: 'new',
          items: [
            ...(writable || input.isRootColumn
              ? [{
                  icon: faFolderPlus,
                  id: 'new-folder',
                  // At the Knowledge root there is no space to create a folder
                  // in. The row being added is a space, which needs a visibility
                  // choice, so its label and dialog say exactly that.
                  label: input.isRootColumn ? 'Space…' : 'Folder',
                  onSelect: input.onCreateFolder,
                }]
              : []),
            // Document and Upload — and any kind a later integrator adds —
            // come from `new-file-types.ts`, the one registry the background
            // menu reads too. Adding a third answer is one entry there, not an
            // edit here and another one over in `FinderContextMenus`.
            ...(writable
              ? newFileTypeItems({
                  openCreate: () => input.onCreateDocument(),
                  openSpreadsheetCreate: input.onCreateSpreadsheet
                    ? () => input.onCreateSpreadsheet?.()
                    : undefined,
                  openSpreadsheetImport: input.onImportSpreadsheet
                    ? () => input.onImportSpreadsheet?.()
                    : undefined,
                  openUploadPicker: () => input.onUploadFile(),
                  // The active folder is already bound into each callback by
                  // `useFinderToolbar`; the registry's own `parentPageId` is
                  // only for call sites that pass it through.
                  parentPageId: null,
                  spaceId: '',
                })
              : []),
          ],
          kind: 'menu',
          label: 'New',
          menuStyle: 'sidebar',
          primary: true,
          priority: 100,
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
