import { Link, useLocation, useParams } from 'react-router-dom'
import { ProjectOverviewPlaceholder } from '../../components/features/projects/ProjectOverviewPlaceholder'
import { NewTaskButton } from '../../components/kanban/NewTaskButton'
import { useProjectBoard } from '../../facades/board/hooks'
import { useIterations } from '../../facades/iterations/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { MobileMenuButton } from '../../layouts/admin-shell/MobileMenuButton'
import { ProjectBacklogTab } from './ProjectBacklogTab'
import { ProjectBoardTab } from './ProjectBoardTab'
import { ProjectDocsTab } from './ProjectDocsTab'
import { ProjectInsightsTab } from './ProjectInsightsTab'
import { ProjectSettingsPage } from './ProjectSettingsPage'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const ProjectView = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const { data: projects = [] } = useProjects()
  const { data: board } = useProjectBoard(projectId)

  if (!projectId) return null

  const project = projects.find((p) => p.id === projectId)
  const isScrum = board?.style === 'scrum'
  const { data: iterations = [] } = useIterations(isScrum ? projectId : undefined)
  const activeIteration = iterations.find((iteration) => iteration.status === 'active')
  const tab = location.pathname.endsWith('/settings')
    ? 'settings'
    : location.pathname.endsWith('/docs')
      ? 'docs'
      : location.pathname.endsWith('/backlog')
        ? 'backlog'
        : location.pathname.endsWith('/insights')
          ? 'insights'
          : location.pathname.endsWith('/board')
            ? 'board'
            : 'overview'

  const tabs = [
    { id: 'overview', label: 'Overview', to: `/projects/${projectId}` },
    { id: 'board', label: 'Board', to: `/projects/${projectId}/board` },
    ...(isScrum
      ? [
          { id: 'backlog', label: 'Backlog', to: `/projects/${projectId}/backlog` },
          { id: 'insights', label: 'Insights', to: `/projects/${projectId}/insights` },
        ]
      : []),
    { id: 'docs', label: 'Docs', to: `/projects/${projectId}/docs` },
    { id: 'settings', label: 'Settings', to: `/projects/${projectId}/settings` },
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className={sectionTitle}>{project?.name ?? 'Project'}</div>
        <nav className="flex gap-1">
          {tabs.map((item) => (
            <Link
              key={item.id}
              className={[
                'rounded-md px-2.5 py-1 text-xs font-semibold',
                tab === item.id
                  ? 'bg-[color:var(--overlay)] text-[color:var(--tx)]'
                  : 'text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
              ].join(' ')}
              to={item.to}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {board ? (
            <span className="text-xs text-[color:var(--tx3)]">
              {board.style === 'scrum' ? 'Scrum' : 'Kanban'}
            </span>
          ) : null}
          {tab === 'board' ? (
            <div>
              <NewTaskButton
                iterationId={isScrum ? activeIteration?.id : undefined}
                projectId={projectId}
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {tab === 'settings' ? (
          <ProjectSettingsPage projectId={projectId} />
        ) : tab === 'docs' ? (
          <ProjectDocsTab projectId={projectId} />
        ) : tab === 'backlog' ? (
          <ProjectBacklogTab projectId={projectId} />
        ) : tab === 'insights' ? (
          <ProjectInsightsTab projectId={projectId} />
        ) : tab === 'overview' ? (
          <ProjectOverviewPlaceholder projectName={project?.name ?? 'Project'} />
        ) : (
          <ProjectBoardTab projectId={projectId} />
        )}
      </div>
    </section>
  )
}
