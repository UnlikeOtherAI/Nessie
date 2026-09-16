import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useProjectBoards } from '../../../facades/boards/hooks'
import { useChannels } from '../../../facades/channels/hooks'
import { useDashboard, useDashboards } from '../../../facades/dashboards/hooks'
import { useProjectRecentPages } from '../../../facades/knowledge/recent-pages-hooks'
import { useCanModifyProject } from '../../../facades/projects/administration'
import { useProjectMembers, useProjects } from '../../../facades/projects/hooks'
import { useTasks } from '../../../facades/tasks/hooks'
import { ScaledDashboard, TILE_CANVAS_WIDTH } from '../dashboards/ScaledDashboard'
import { SkeletonBlock } from '../../primitives/Skeleton'
import { ProjectMembersDialog } from '../../shared/ProjectMembersDialog'
import {
  RECENT_PAGE_LIMIT,
  backlogTaskCount,
  formatRelativeAge,
  isOpenTask,
  projectChannelRows,
} from './project-dashboard-data'
import { projectNavigationTiles, type ProjectNavigationTile } from './project-navigation-tiles'

type ProjectNavigationTilesProps = {
  className?: string
  projectId: string
}

/**
 * The navigation-first band at the top of a project's Overview: one coloured
 * card per place a person can go from here, each saying what is in it, so
 * arriving at a project is an organised visit rather than a wall of read-only
 * summaries.
 *
 * Which doorways, in what order, and what each one says is
 * `project-navigation-tiles.ts` — derived from the same `projectSections` list
 * the sidebar draws, so the two cannot drift. This file is the rendering, the
 * reads behind the counts, and the one piece of state: People has no section of
 * its own, so it opens the dialog the header's Members button opens.
 *
 * Every read here is one the page already makes — the Work column reads the
 * same tasks, the Documents column the same pages, and the channel list is the
 * shell's own — so the counts cost no extra request.
 */
export const ProjectNavigationTiles = ({ className, projectId }: ProjectNavigationTilesProps) => {
  const { data: projects = [] } = useProjects()
  const { data: boards = [] } = useProjectBoards(projectId)
  const { data: members = [] } = useProjectMembers(projectId)
  const { data: channels = [] } = useChannels()
  const { data: tasks = [] } = useTasks(projectId)
  const { data: pages = [] } = useProjectRecentPages(projectId, RECENT_PAGE_LIMIT)
  const { data: dashboards = [] } = useDashboards(projectId)
  const canManageMembers = useCanModifyProject(projectId)
  const [membersOpen, setMembersOpen] = useState(false)

  const project = projects.find((candidate) => candidate.id === projectId)
  const isScrum = boards.some((board) => board.style === 'scrum')
  const tiles = projectNavigationTiles({
    backlogCount: isScrum ? backlogTaskCount(tasks) : 0,
    canManageMembers,
    channels: projectChannelRows(channels, projectId),
    dashboards,
    documentsUpdatedAge: formatRelativeAge(pages[0]?.updatedAt),
    isScrum,
    memberCount: members.length,
    openWorkCount: tasks.filter(isOpenTask).length,
    projectId,
  })

  return (
    <>
      <nav aria-label="Project sections" className={['project-nav-grid', className ?? ''].join(' ')}>
        {tiles.map((tile) => (
          <Tile key={tile.key} onOpenMembers={() => setMembersOpen(true)} tile={tile} />
        ))}
      </nav>
      {membersOpen && project ? (
        <ProjectMembersDialog
          canManage={canManageMembers}
          onClose={() => setMembersOpen(false)}
          project={project}
        />
      ) : null}
    </>
  )
}

/**
 * A dashboard as a tile: the live thing, scaled, with its name captioned
 * underneath. It is its own component because it reads the dashboard's widgets
 * — the grid's list read carries titles only — and a hook cannot be called
 * from inside a `map`.
 *
 * It takes its height from the grid row rather than measuring its own content,
 * so a dashboard never stretches the fixed doorways beside it; `styles.css`
 * gives the frame a floor so a row of nothing but dashboards still has a
 * readable one.
 */
const DashboardTile = ({ tile }: { tile: ProjectNavigationTile }) => {
  const navigate = useNavigate()
  const { data: dashboard } = useDashboard(tile.dashboardId)

  return (
    <div className="project-nav-tile" data-dashboard="true" data-tone={tile.tone}>
      {dashboard ? (
        <ScaledDashboard
          ariaLabel={`Open ${tile.label}`}
          canvasWidth={TILE_CANVAS_WIDTH}
          dashboard={dashboard}
          fill
          onOpen={() => { if (tile.to) void navigate(tile.to) }}
        />
      ) : (
        <SkeletonBlock className="scaled-dashboard rounded-none" />
      )}
      <span className="project-nav-tile-caption">
        <span className="project-nav-tile-title">{tile.label}</span>
      </span>
    </div>
  )
}

const Tile = ({
  onOpenMembers,
  tile,
}: {
  onOpenMembers: () => void
  tile: ProjectNavigationTile
}) => {
  if (tile.dashboardId) return <DashboardTile tile={tile} />

  const body: ReactNode = (
    <>
      <span aria-hidden="true" className="project-nav-tile-art">
        <FontAwesomeIcon icon={tile.icon} />
      </span>
      <span className="project-nav-tile-title">
        {tile.label}
        {tile.meta ? <span className="project-nav-tile-meta">{tile.meta}</span> : null}
      </span>
      <span className="project-nav-tile-blurb">{tile.blurb}</span>
    </>
  )

  if (tile.to) {
    return (
      <Link className="project-nav-tile" data-tone={tile.tone} to={tile.to}>
        {body}
      </Link>
    )
  }
  if (tile.opensMembers) {
    return (
      <button className="project-nav-tile" data-tone={tile.tone} onClick={onOpenMembers} type="button">
        {body}
      </button>
    )
  }
  // Nowhere to go yet — a project with no channels. The tile stays in the grid
  // and says why, rather than vanishing and leaving the reader to wonder where
  // this project's rooms are.
  return (
    <div className="project-nav-tile" data-empty="true" data-tone={tile.tone}>
      {body}
    </div>
  )
}
