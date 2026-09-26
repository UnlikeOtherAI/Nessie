/**
 * The doorways on a project's Overview, derived rather than restated.
 *
 * `projectSections` is the one list of a project's sections — the Projects
 * sidebar draws it and `ProjectView` routes to it — so the Overview grid is
 * built from that same list. A section added there appears here without
 * anybody remembering to add it, which is the point: a doorway that exists in
 * one surface and not another is the failure AGENTS.md → "Rule zero" is about.
 *
 * Two doorways have no section of their own and are inserted by hand, because
 * the page below the grid does not list them any more: Channels and People.
 * That is deliberate — a project's rooms and its people used to have a summary
 * card each, which put Members on the screen three times (the header button,
 * the tile, the card). Each tile now carries what is in it, so the count is
 * said once.
 *
 * Pure, and separate from the component, for the reason
 * `project-dashboard-data.ts` is: the ordering and the gating are the parts
 * worth testing, and they are testable without rendering React.
 */

import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faChartPie, faHashtag, faUsers } from '@fortawesome/free-solid-svg-icons'
import type { TFunction } from 'i18next'
import { projectSections, type ProjectSectionId } from '../../../navigation/project-sections'

/** Everything a project section is, except Overview: a doorway does not link to itself. */
export type ProjectTileSectionId = Exclude<ProjectSectionId, 'overview'>

export type ProjectTileKey = ProjectTileSectionId | 'channels' | 'people' | `dashboard:${string}`

/**
 * The tone names what the destination *is*, not which token it borrows, so the
 * palette can be retuned in `styles.css` without renaming anything here.
 */
export type ProjectTileTone =
  | 'work'
  | 'plan'
  | 'insight'
  | 'knowledge'
  | 'rooms'
  | 'people'
  | 'compute'
  | 'config'

export type ProjectNavigationTile = {
  blurb: string
  /**
   * A live dashboard of this project, rendered small in place of the tile's
   * icon and blurb. The dashboard cards continue the coloured navigation
   * cards rather than forming a band of their own: going to a dashboard is
   * navigation, and it belongs with the other places a person can go.
   */
  dashboardId?: string
  icon: IconDefinition
  key: ProjectTileKey
  label: string
  /** What is in there, said once: "12 open", "4 people", "updated 2h". */
  meta?: string
  /** The members dialog, for the one doorway that is not a route. */
  opensMembers?: true
  /** Absent when the tile has nowhere to go — a project with no channels yet. */
  to?: string
  tone: ProjectTileTone
}

/**
 * A tile's own words and its colour. Exhaustive by type: a section added to
 * `projectSections` without a line of copy here fails to compile, rather than
 * rendering an unexplained coloured square.
 */
const SECTION_TONE: Record<ProjectTileSectionId, ProjectTileTone> = {
  backlog: 'plan',
  board: 'work',
  dashboards: 'insight',
  docs: 'knowledge',
  executors: 'compute',
  insights: 'insight',
  settings: 'config',
}

type ProjectNavigationTilesInput = {
  /** Open tickets in no sprint. Only shown on a scrum project, which is the only one with a Backlog. */
  backlogCount: number
  /** This project's dashboards, newest first. One tile each, after the sections. */
  dashboards: readonly { id: string; title: string }[]
  /** The project's conversation rooms, most active first; the tile opens the first. */
  channels: readonly { id: string; label: string }[]
  /** Whether the reader may add and remove people; changes the People tile's words only. */
  canManageMembers: boolean
  /** When the project's knowledge was last written to, already formatted ("2h"). */
  documentsUpdatedAge: string | null
  isScrum: boolean
  memberCount: number
  /** Everything still open on the project's boards. */
  openWorkCount: number
  projectId: string
}

const count = (
  t: TFunction<'projects'>,
  value: number,
  key: 'open' | 'waiting' | 'dashboards' | 'channels' | 'people',
): string | undefined => {
  // Nothing, or still loading: a tile says nothing rather than "0 people".
  if (value <= 0) return undefined
  switch (key) {
    case 'open': return t('navigation.meta.open', { count: value })
    case 'waiting': return t('navigation.meta.waiting', { count: value })
    case 'dashboards': return t('navigation.meta.dashboards', { count: value })
    case 'channels': return t('navigation.meta.channels', { count: value })
    case 'people': return t('navigation.meta.people', { count: value })
  }
}

const sectionMeta = (
  id: ProjectTileSectionId,
  input: ProjectNavigationTilesInput,
  t: TFunction<'projects'>,
): string | undefined => {
  switch (id) {
    case 'board':
      return count(t, input.openWorkCount, 'open')
    case 'backlog':
      return count(t, input.backlogCount, 'waiting')
    // A count here would be a lie: the recent-pages read is capped, so it
    // knows the newest document but not how many there are. Recency is the
    // honest signal, and the one a person is looking for.
    case 'docs':
      return input.documentsUpdatedAge ? t('navigation.meta.updated', { age: input.documentsUpdatedAge }) : undefined
    case 'dashboards':
      return count(t, input.dashboards.length, 'dashboards')
    // Insights is a view of the counts beside it; Executors are an
    // organisation-wide pool, so a project-scoped number would be invented;
    // Settings has nothing to count.
    case 'insights':
    case 'executors':
    case 'settings':
      return undefined
  }
}

export const projectNavigationTiles = (
  input: ProjectNavigationTilesInput,
  t: TFunction<'projects'>,
): ProjectNavigationTile[] => {
  // No counts passed to `projectSections`: it bakes an assigned-work total into
  // its label for the sidebar, and a tile carries its own, so `Boards (3)`
  // beside `12 open` would read as two different numbers for one thing.
  const sections = projectSections({ isScrum: input.isScrum, projectId: input.projectId })
    .filter((section) => section.id !== 'overview')
    .map((section): ProjectNavigationTile => {
      const id = section.id as ProjectTileSectionId
      let label: string
      let blurb: string
      switch (id) {
        case 'backlog':
          label = t('navigation.tileLabels.backlog')
          blurb = t('navigation.tileBlurbs.backlog')
          break
        case 'board':
          label = t('navigation.tileLabels.board')
          blurb = t('navigation.tileBlurbs.board')
          break
        case 'dashboards':
          label = t('navigation.tileLabels.dashboards')
          blurb = t('navigation.tileBlurbs.dashboards')
          break
        case 'docs':
          label = t('navigation.tileLabels.docs')
          blurb = t('navigation.tileBlurbs.docs')
          break
        case 'executors':
          label = t('navigation.tileLabels.executors')
          blurb = t('navigation.tileBlurbs.executors')
          break
        case 'insights':
          label = t('navigation.tileLabels.insights')
          blurb = t('navigation.tileBlurbs.insights')
          break
        case 'settings':
          label = t('navigation.tileLabels.settings')
          blurb = t('navigation.tileBlurbs.settings')
          break
      }
      return {
        blurb,
        icon: section.icon,
        key: id,
        label,
        ...(sectionMeta(id, input, t) ? { meta: sectionMeta(id, input, t) } : {}),
        to: section.to,
        tone: SECTION_TONE[id],
      }
    })

  const firstChannel = input.channels[0]
  const channels: ProjectNavigationTile = {
    blurb: firstChannel
      ? t('navigation.tiles.channelsDescription')
      : t('navigation.tiles.noChannelsDescription'),
    icon: faHashtag,
    key: 'channels',
    label: t('navigation.tileLabels.channels'),
    meta: count(t, input.channels.length, 'channels'),
    // The most active room, which is where a person going "to the channels"
    // means to end up. With none there is nowhere to send them, and a tile
    // that navigates to an empty list is worse than one that says so.
    ...(firstChannel ? { to: `/channels/${firstChannel.id}` } : {}),
    tone: 'rooms',
  }

  const people: ProjectNavigationTile = {
    blurb: input.canManageMembers
      ? t('navigation.tiles.peopleCanManageDescription')
      : t('navigation.tiles.peopleDescription'),
    icon: faUsers,
    key: 'people',
    label: t('navigation.tileLabels.people'),
    meta: count(t, input.memberCount, 'people'),
    opensMembers: true,
    tone: 'people',
  }

  // One tile per dashboard, each rendering the live thing rather than naming
  // it. They follow the sections instead of being mixed among them, so the
  // fixed doorways stay in one stable block a person learns the shape of.
  const dashboards: ProjectNavigationTile[] = input.dashboards.map((dashboard) => ({
    blurb: '',
    dashboardId: dashboard.id,
    icon: faChartPie,
    key: `dashboard:${dashboard.id}`,
    label: dashboard.title,
    to: `/projects/${input.projectId}/dashboards/${dashboard.id}`,
    tone: 'insight',
  }))

  // Channels and People sit with the other "manage this project" doorways
  // rather than at the top: the work is what a person came for.
  const before = sections.findIndex((tile) => tile.key === 'executors')
  const ordered = before === -1
    ? [...sections, channels, people]
    : [...sections.slice(0, before), channels, people, ...sections.slice(before)]
  return [...ordered, ...dashboards]
}
