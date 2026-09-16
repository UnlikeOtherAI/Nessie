import {
  faArrowDownAZ,
  faClockRotateLeft,
  faDownload,
  faExpand,
  faFilter,
  faMagnifyingGlass,
  faSliders,
  faCodeCommit,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { RefObject } from 'react'

/**
 * The controls IronCalc does not have.
 *
 * The pane never re-implements something the widget already draws: formatting,
 * the formula bar, the sheet tabs and the name box all stay IronCalc's. What
 * sits here is what the library lacks — sort, filter, find & replace, history,
 * save version, export, fullscreen — plus the phone's "Format" toggle, which
 * hides *its* toolbar so the grid keeps the height below 480px.
 *
 * Under the `single` breakpoint the bar collapses to icons. The labels stay in
 * `aria-label` and in the tooltip, so nothing is lost to a screen reader.
 */

export type SpreadsheetActionId =
  | 'export'
  | 'filter'
  | 'find'
  | 'format-bar'
  | 'fullscreen'
  | 'history'
  | 'save-version'
  | 'sort'

type Action = {
  icon: IconDefinition
  id: SpreadsheetActionId
  label: string
  /** Anchors the popover this action opens. */
  ref?: RefObject<HTMLButtonElement | null>
  title: string
  /** Drawn pressed while its surface is open. */
  pressed?: boolean
  /** Hidden rather than disabled when the viewer cannot write. */
  writeOnly?: boolean
}

type SpreadsheetActionBarProps = {
  canWrite: boolean
  /** Icon-only, for the phone layout. */
  compact?: boolean
  filterButtonRef?: RefObject<HTMLButtonElement | null>
  filterOpen?: boolean
  findButtonRef?: RefObject<HTMLButtonElement | null>
  findOpen?: boolean
  formatBarVisible?: boolean
  fullscreen?: boolean
  onSelect: (id: SpreadsheetActionId) => void
  /** Only drawn on the phone layout, where IronCalc's toolbar costs grid height. */
  showFormatToggle?: boolean
}

const buttonClass = (pressed: boolean): string =>
  [
    'admin-button admin-button-compact gap-1.5',
    pressed ? 'admin-button-primary' : 'admin-button-secondary',
  ].join(' ')

export const SpreadsheetActionBar = ({
  canWrite,
  compact = false,
  filterButtonRef,
  filterOpen = false,
  findButtonRef,
  findOpen = false,
  formatBarVisible = true,
  fullscreen = false,
  onSelect,
  showFormatToggle = false,
}: SpreadsheetActionBarProps) => {
  const actions: Action[] = [
    { icon: faArrowDownAZ, id: 'sort', label: 'Sort…', title: 'Sort a range', writeOnly: true },
    {
      icon: faFilter,
      id: 'filter',
      label: 'Filter',
      pressed: filterOpen,
      ref: filterButtonRef,
      title: 'Filter rows by a column',
    },
    {
      icon: faMagnifyingGlass,
      id: 'find',
      label: 'Find & replace',
      pressed: findOpen,
      ref: findButtonRef,
      title: 'Find and replace (⌘F)',
    },
    {
      icon: faCodeCommit,
      id: 'save-version',
      label: 'Save version',
      title: 'Save a named version you can restore to',
      writeOnly: true,
    },
    {
      icon: faClockRotateLeft,
      id: 'history',
      label: 'History',
      title: 'Versions, and restore',
    },
    { icon: faDownload, id: 'export', label: 'Export', title: 'Download as xlsx or CSV' },
    ...(showFormatToggle
      ? [{
          icon: faSliders,
          id: 'format-bar' as const,
          label: formatBarVisible ? 'Hide Format' : 'Format',
          pressed: formatBarVisible,
          title: 'Show or hide the formatting toolbar',
        }]
      : []),
    {
      icon: faExpand,
      id: 'fullscreen',
      label: fullscreen ? 'Exit fullscreen' : 'Fullscreen',
      pressed: fullscreen,
      title: 'Fill the window with the grid',
    },
  ]

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-[color:var(--sep)] bg-[color:var(--panel)] px-3 py-2"
      data-testid="spreadsheet-action-bar"
      role="toolbar"
      aria-label="Spreadsheet actions"
    >
      {actions
        .filter((action) => canWrite || !action.writeOnly)
        .map((action) => (
          <button
            aria-label={action.label}
            aria-pressed={action.pressed ?? undefined}
            className={buttonClass(action.pressed ?? false)}
            data-testid={`spreadsheet-action-${action.id}`}
            key={action.id}
            onClick={() => onSelect(action.id)}
            ref={action.ref}
            title={action.title}
            type="button"
          >
            <FontAwesomeIcon icon={action.icon} />
            {compact ? null : action.label}
          </button>
        ))}
    </div>
  )
}
