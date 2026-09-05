import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { TaskDialog } from '../../components/kanban/TaskDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { useProjectBoards } from '../../facades/boards/hooks'
import { BoardSwitcher } from '../../components/kanban/BoardSwitcher'
import { useTabParam } from '../../navigation/useTabParam'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { useAttentionSummary } from '../../facades/alerts/hooks'
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
  const { data: attention } = useAttentionSummary()

  // Which board is on screen. A tab, so it rides in `?board=` written with
  // `replace`; an unknown or absent value reads as the project's default
  // board, so a stale bookmark degrades to the board the project opens on.
  const defaultBoardId = boards.find((item) => item.isDefault)?.id ?? boards[0]?.id ?? ''
  const boardIds: string[] = boards.map((item) => item.id)
  const [activeBoardId, selectBoard] = useTabParam('board', boardIds, defaultBoardId)
  const board = boards.find((item) => item.id === activeBoardId) ?? null

  if (!projectId) return null

  const project = projects.find((p) => p.id === projectId)
  // Backlog and Insights are project-level, so they appear when *any* board of
  // this project runs sprints — not only when the one on screen does.
  const isScrum = boards.some((item) => item.style === 'scrum')
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)
  const tab = location.pathname.endsWith('/settings')
    ? 'settings'
    : location.pathname.endsWith('/docs')
      ? 'docs'
      : location.pathname.endsWith('/backlog')
        ? 'backlog'
    : location.pathname.endsWith('/insights')
      ? 'insights'
      : location.pathname.endsWith('/executors')
        ? 'executors'
          : location.pathname.endsWith('/board')
            ? 'board'
            : 'overview'

  const assignedWorkCount = attention?.assignedWork.projects[projectId] ?? 0
  const knowledgeCount = attention?.knowledge.projects[projectId] ?? 0
  const withCount = (label: string, count: number): string => count > 0 ? `${label} (${count})` : label
  const tabs = [
    { id: 'overview', label: 'Overview', to: `/projects/${projectId}` },
    { id: 'board', label: withCount('Board', assignedWorkCount), to: `/projects/${projectId}/board` },
    ...(isScrum
      ? [
          { id: 'backlog', label: 'Backlog', to: `/projects/${projectId}/backlog` },
          { id: 'insights', label: 'Insights', to: `/projects/${projectId}/insights` },
        ]
      : []),
    { id: 'docs', label: withCount('Docs', knowledgeCount), to: `/projects/${projectId}/docs` },
    { id: 'executors', label: 'Executors', to: `/projects/${projectId}/executors` },
    { id: 'settings', label: 'Settings', to: `/projects/${projectId}/settings` },
  ]
  const activeTab = tabs.find((item) => item.id === tab)
  const headerActions: PageHeaderAction[] = [
    {
      id: 'project-section',
      items: tabs.map((item) => ({
        checked: item.id === tab,
        id: item.id,
        label: item.label,
        // A project section is a tab, and a tab is never a history entry
        // (docs/navigation/overview.md §1, "Tab hosts"). The seven sections stay real
        // routes so each is linkable, but the header switches them with
        // `replace` so Back leaves the project rather than walking the
        // sections the reader passed through. The registry folds all seven
        // into one tabHost identity, so ProjectView is reconciled in place —
        // the switch never remounts the page or animates a layer.
        onSelect: () => void navigate(item.to, { replace: true }),
      })),
      kind: 'menu',
      label: activeTab?.label ?? 'Section',
      priority: 80,
      title: 'Choose project section',
    },
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
            // Not "Board": the section menu beside it is already labelled with
            // the active section, which on this tab is "Board". Two adjacent
            // menus with one label name no decision between them.
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
