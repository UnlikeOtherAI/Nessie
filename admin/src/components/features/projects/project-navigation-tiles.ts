/**
 * The doorways on a project's Overview, derived rather than restated.
 *
 * `projectSections` is the one list of a project's sections — the Projects
 * sidebar draws it and `ProjectView` routes to it — so the Overview grid is
 * built from that same list. A section added there appears here without
 * anybody remembering to add it, which is the point: a doorway that exists in
 * one surface and not another is the failure AGENTS.md → "Rule zero" is about.
 *
 * Pure, and separate from the component, for the reason
 * `project-dashboard-data.ts` is: the ordering and the gating are the parts
 * worth testing, and they are testable without rendering React.
 */

import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faUsers } from '@fortawesome/free-solid-svg-icons'
import { projectSections, type ProjectSectionId } from '../../../navigation/project-sections'

/** Everything a project section is, except Overview: a doorway does not link to itself. */
export type ProjectTileSectionId = Exclude<ProjectSectionId, 'overview'>

/**
 * The tone names what the destination *is*, not which token it borrows, so the
 * palette can be retuned in `styles.css` without renaming anything here.
 */
export type ProjectTileTone =
  | 'work'
  | 'plan'
  | 'insight'
  | 'knowledge'
  | 'people'
  | 'compute'
  | 'config'

export type ProjectNavigationTile = {
  blurb: string
  icon: IconDefinition
  /** `people` for the members doorway, otherwise the section's own id. */
  key: ProjectTileSectionId | 'people'
  label: string
  /** A live count for what is behind the tile; absent when there is nothing to count. */
  meta?: string
  /** Absent on `people` alone, which opens a dialog rather than navigating. */
  to?: string
  tone: ProjectTileTone
}

/**
 * A tile's own words and its colour. Exhaustive by type: a section added to
 * `projectSections` without a line of copy here fails to compile, rather than
 * rendering an unexplained coloured square.
 */
const SECTION_COPY: Record<ProjectTileSectionId, { blurb: string; tone: ProjectTileTone }> = {
  backlog: { blurb: 'Shape what comes next and fill the sprint.', tone: 'plan' },
  board: { blurb: 'Every piece of work, who holds it, what is late.', tone: 'work' },
  docs: { blurb: 'The knowledge this project writes down and searches.', tone: 'knowledge' },
  executors: { blurb: 'The machines this project’s agents run work on.', tone: 'compute' },
  insights: { blurb: 'Velocity, burndown and where the time goes.', tone: 'insight' },
  settings: { blurb: 'Name, teams, boards, fields and custom work states.', tone: 'config' },
}

type ProjectNavigationTilesInput = {
  /** Shown against Boards, and omitted while the board list is still loading. */
  boardCount: number
  /** Whether the reader may add and remove people; changes the People tile's words only. */
  canManageMembers: boolean
  isScrum: boolean
  memberCount: number
  projectId: string
}

const peopleCount = (count: number): string | undefined => {
  if (count <= 0) return undefined
  return count === 1 ? '1 person' : `${count} people`
}

const boardCountLabel = (count: number): string | undefined => {
  if (count <= 0) return undefined
  return count === 1 ? '1 board' : `${count} boards`
}

export const projectNavigationTiles = ({
  boardCount,
  canManageMembers,
  isScrum,
  memberCount,
  projectId,
}: ProjectNavigationTilesInput): ProjectNavigationTile[] => {
  // No counts passed: the sidebar bakes an assigned-work total into its label
  // and a tile carries its own, so `Boards (3)` would read as two numbers.
  const sections = projectSections({ isScrum, projectId })
    .filter((section) => section.id !== 'overview')
    .map((section): ProjectNavigationTile => {
      const id = section.id as ProjectTileSectionId
      const copy = SECTION_COPY[id]
      return {
        blurb: copy.blurb,
        icon: section.icon,
        key: id,
        label: section.label,
        ...(id === 'board' ? { meta: boardCountLabel(boardCount) } : {}),
        to: section.to,
        tone: copy.tone,
      }
    })

  const people: ProjectNavigationTile = {
    blurb: canManageMembers
      ? 'Add and remove the people working in this project.'
      : 'Who is working in this project.',
    icon: faUsers,
    key: 'people',
    label: 'People',
    meta: peopleCount(memberCount),
    tone: 'people',
  }

  // People sits with the other "manage this project" doorways rather than at
  // the top: the work is what a person came for.
  const before = sections.findIndex((tile) => tile.key === 'executors')
  return before === -1
    ? [...sections, people]
    : [...sections.slice(0, before), people, ...sections.slice(before)]
}
