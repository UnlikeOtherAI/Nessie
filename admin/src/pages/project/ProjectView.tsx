import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { TaskDialog } from '../../components/kanban/TaskDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { useProjectBoard } from '../../facades/board/hooks'
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
  const { data: board } = useProjectBoard(projectId)
  const { data: attention } = useAttentionSummary()

  if (!projectId) return null

  const project = projects.find((p) => p.id === projectId)
  const isScrum = board?.style === 'scrum'
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
        onSelect: () => void navigate(item.to),
      })),
      kind: 'menu',
      label: activeTab?.label ?? 'Section',
      priority: 80,
      title: 'Choose project section',
    },
    ...(tab === 'board'
      ? [{
          id: 'new-task',
          label: 'New task',
          onSelect: () => setTaskDialogOpen(true),
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction]
      : []),
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ProjectPageHeader actions={headerActions} project={project} titleTone="page" />

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
          <ProjectBoardTab projectId={projectId} />
        )}
      </div>
      <TaskDialog
        iterationId={isScrum ? activeIteration?.id : undefined}
        onClose={() => setTaskDialogOpen(false)}
        open={taskDialogOpen}
        projectId={projectId}
      />
    </section>
  )
}
