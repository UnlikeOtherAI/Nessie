import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { TaskDialog } from '../../components/features/projects/kanban/TaskDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { useProjectBoards } from '../../facades/boards/hooks'
import { BoardSwitcher } from '../../components/features/projects/kanban/BoardSwitcher'
import { useTabParam } from '../../navigation/useTabParam'
import { projectSectionIdFromPathname } from '../../navigation/project-sections'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useState } from 'react'
import { ProjectBacklogTab } from './ProjectBacklogTab'
import { ProjectBoardTab } from './ProjectBoardTab'
import { ProjectDocsTab } from './ProjectDocsTab'
import { ProjectInsightsTab } from './ProjectInsightsTab'
import { ProjectExecutorsTab } from './ProjectExecutorsTab'
import { ProjectSettingsPage } from './ProjectSettingsPage'

export const ProjectView = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const { data: boards = [] } = useProjectBoards(projectId)

  // Which board is on screen. A tab, so it rides in `?board=` written with
  // `replace`; an unknown or absent value reads as the project's default
  // board, so a stale bookmark degrades to the board the project opens on.
  const defaultBoardId = boards.find((item) => item.isDefault)?.id ?? boards[0]?.id ?? ''
  const boardIds: string[] = boards.map((item) => item.id)
  const [activeBoardId, selectBoard] = useTabParam('board', boardIds, defaultBoardId)
  const board = boards.find((item) => item.id === activeBoardId) ?? null

  const project = projects.find((p) => p.id === projectId)
  // Backlog and Insights are project-level, so they appear when *any* board of
  // this project runs sprints — not only when the one on screen does.
  const isScrum = boards.some((item) => item.style === 'scrum')
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)

  // `projectId` only goes missing on a malformed URL, and the guard sits below
  // every hook so the hook order never depends on it (rules-of-hooks). The
  // queries above already no-op on an undefined id.
  if (!projectId) return null
  // A project's sections are chosen in the Projects sidebar, which draws them
  // as the project's subpages (`navigation/project-sections.ts`). The header
  // carries no section dropdown: two doorways to the same seven routes only
  // made the reader guess which one moved them.
  const tab = projectSectionIdFromPathname(location.pathname)

  const headerActions: PageHeaderAction[] = [
    // The doorways to board administration, from the screen a person is
    // standing on when they want them — not only from Settings.
    ...(tab === 'board'
      ? [
          {
            id: 'board-admin',
            items: [
              {
                id: 'edit-columns',
                label: 'Board settings…',
                onSelect: () =>
                  void navigate(
                    `/projects/${projectId}/settings?section=boards${
                      board ? `&board=${board.id}` : ''
                    }`,
                  ),
              },
              {
                id: 'new-board',
                label: 'New board…',
                onSelect: () =>
                  void navigate(
                    `/projects/${projectId}/settings?section=boards&create=board`,
                  ),
              },
            ],
            kind: 'menu',
            // Not "Board": the board switcher already sits in the header's tab
            // slot on this section, so a second "Board" would name no decision.
            label: 'Configure',
            priority: 60,
            title: 'Configure boards',
          } satisfies PageHeaderAction,
          {
            id: 'new-task',
            label: 'New task',
            onSelect: () => setTaskDialogOpen(true),
            primary: true,
            priority: 100,
          } satisfies PageHeaderAction,
        ]
      : []),
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ProjectPageHeader
        actions={headerActions}
        project={project}
        tabs={
          tab === 'board' ? (
            <BoardSwitcher
              activeBoardId={activeBoardId}
              boards={boards}
              onSelect={selectBoard}
            />
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1">
        {tab === 'settings' ? (
          <ProjectSettingsPage projectId={projectId} />
        ) : tab === 'docs' ? (
          <ProjectDocsTab projectId={projectId} />
        ) : tab === 'backlog' ? (
          <ProjectBacklogTab projectId={projectId} />
        ) : tab === 'insights' ? (
          <ProjectInsightsTab projectId={projectId} />
        ) : tab === 'executors' ? (
          <ProjectExecutorsTab projectId={projectId} />
        ) : tab === 'overview' ? (
          <ProjectDashboard projectId={projectId} />
        ) : (
          <ProjectBoardTab board={board} projectId={projectId} />
        )}
      </div>
      <TaskDialog
        iterationId={board?.style === 'scrum' ? activeIteration?.id : undefined}
        onClose={() => setTaskDialogOpen(false)}
        open={taskDialogOpen}
        projectId={projectId}
      />
    </section>
  )
}
