/**
 * A project's sections, in one list.
 *
 * Two surfaces render them and they must not drift: the Projects sidebar draws
 * them as a project's subpages, and `ProjectView` routes to them. The sidebar
 * is the only doorway — the project header no longer carries a section
 * dropdown — so a section missing from this list is a section nobody can
 * reach (AGENTS.md → "Rule zero").
 *
 * Backlog and Insights are project-level, so they appear when *any* board of
 * the project runs sprints, not only when the board on screen does.
 */

import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  faBook,
  faChartColumn,
  faGaugeHigh,
  faGear,
  faListCheck,
  faServer,
  faTableColumns,
} from '@fortawesome/free-solid-svg-icons'

/** The glyph for a board row, shared by the Boards section and each board under it. */
export const BOARD_ICON = faTableColumns

export type ProjectSectionId =
  | 'overview'
  | 'board'
  | 'backlog'
  | 'insights'
  | 'docs'
  | 'executors'
  | 'settings'

export type ProjectSection = {
  /** The row's glyph. Every section carries one, so the column reads as a list. */
  icon: IconDefinition
  id: ProjectSectionId
  label: string
  to: string
}

/** The section a project pathname is showing; the bare project route is Overview. */
export const projectSectionIdFromPathname = (pathname: string): ProjectSectionId => {
  const suffix = /\/projects\/[^/]+\/([^/?#]+)/.exec(pathname)?.[1]
  switch (suffix) {
    case 'board':
    case 'backlog':
    case 'insights':
    case 'docs':
    case 'executors':
    case 'settings':
      return suffix
    default:
      return 'overview'
  }
}

type ProjectSectionsInput = {
  /** Work in this project waiting on the reader, shown against Board. */
  assignedWorkCount?: number
  isScrum: boolean
  /** Knowledge in this project waiting on the reader, shown against Docs. */
  knowledgeCount?: number
  projectId: string
}

const withCount = (label: string, count: number): string =>
  count > 0 ? `${label} (${count})` : label

export const projectSections = ({
  assignedWorkCount = 0,
  isScrum,
  knowledgeCount = 0,
  projectId,
}: ProjectSectionsInput): ProjectSection[] => [
  { icon: faGaugeHigh, id: 'overview', label: 'Overview', to: `/projects/${projectId}` },
  {
    icon: BOARD_ICON,
    id: 'board',
    // Plural: the section holds every board of the project, and it says so even
    // while a project has only one.
    label: withCount('Boards', assignedWorkCount),
    to: `/projects/${projectId}/board`,
  },
  ...(isScrum
    ? ([
        {
          icon: faListCheck,
          id: 'backlog',
          label: 'Backlog',
          to: `/projects/${projectId}/backlog`,
        },
        {
          icon: faChartColumn,
          id: 'insights',
          label: 'Insights',
          to: `/projects/${projectId}/insights`,
        },
      ] satisfies ProjectSection[])
    : []),
  {
    icon: faBook,
    id: 'docs',
    label: withCount('Docs', knowledgeCount),
    to: `/projects/${projectId}/docs`,
  },
  { icon: faServer, id: 'executors', label: 'Executors', to: `/projects/${projectId}/executors` },
  { icon: faGear, id: 'settings', label: 'Settings', to: `/projects/${projectId}/settings` },
]
