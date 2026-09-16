import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useProjectBoards } from '../../../facades/boards/hooks'
import { useCanModifyProject } from '../../../facades/projects/administration'
import { useProjectMembers, useProjects } from '../../../facades/projects/hooks'
import { ProjectMembersDialog } from '../../shared/ProjectMembersDialog'
import { projectNavigationTiles } from './project-navigation-tiles'

type ProjectNavigationTilesProps = {
  className?: string
  projectId: string
}

/**
 * The navigation-first band at the top of a project's Overview: one coloured
 * card per place a person can go from here, so arriving at a project is an
 * organised visit rather than a wall of read-only summaries.
 *
 * Which doorways, in what order, and what each one says is
 * `project-navigation-tiles.ts` — derived from the same `projectSections` list
 * the sidebar draws, so the two cannot drift. This file is the rendering and
 * the one piece of state: People has no section of its own, so it opens the
 * dialog the header's Members button opens, which is why it is the one tile
 * that is a button rather than a link.
 *
 * Every read here is already made by the summary cards below (React Query
 * dedupes them), so the band costs no extra request.
 */
export const ProjectNavigationTiles = ({ className, projectId }: ProjectNavigationTilesProps) => {
  const { data: projects = [] } = useProjects()
  const { data: boards = [] } = useProjectBoards(projectId)
  const { data: members = [] } = useProjectMembers(projectId)
  const canManageMembers = useCanModifyProject(projectId)
  const [membersOpen, setMembersOpen] = useState(false)

  const project = projects.find((candidate) => candidate.id === projectId)
  const tiles = projectNavigationTiles({
    boardCount: boards.length,
    canManageMembers,
    isScrum: boards.some((board) => board.style === 'scrum'),
    memberCount: members.length,
    projectId,
  })

  return (
    <>
      <nav aria-label="Project sections" className={['project-nav-grid', className ?? ''].join(' ')}>
        {tiles.map((tile) => {
          const body = (
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
          return tile.to ? (
            <Link className="project-nav-tile" data-tone={tile.tone} key={tile.key} to={tile.to}>
              {body}
            </Link>
          ) : (
            <button
              className="project-nav-tile"
              data-tone={tile.tone}
              // The project has not loaded yet: the dialog takes the record,
              // so the doorway waits rather than opening on nothing.
              disabled={!project}
              key={tile.key}
              onClick={() => setMembersOpen(true)}
              type="button"
            >
              {body}
            </button>
          )
        })}
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
