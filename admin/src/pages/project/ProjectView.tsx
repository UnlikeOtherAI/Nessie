import { Link, useLocation, useParams } from 'react-router-dom'
import { useProjectBoard } from '../../facades/board/hooks'
import { useProjects } from '../../facades/projects/hooks'
import { ProjectBacklogTab } from './ProjectBacklogTab'
import { ProjectBoardTab } from './ProjectBoardTab'
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
  const tab = location.pathname.endsWith('/settings')
    ? 'settings'
    : location.pathname.endsWith('/backlog')
      ? 'backlog'
      : location.pathname.endsWith('/insights')
        ? 'insights'
        : 'board'

  const tabs = [
    { id: 'board', label: 'Board', to: `/projects/${projectId}` },
    ...(isScrum
      ? [
          { id: 'backlog', label: 'Backlog', to: `/projects/${projectId}/backlog` },
          { id: 'insights', label: 'Insights', to: `/projects/${projectId}/insights` },
        ]
      : []),
    { id: 'settings', label: 'Settings', to: `/projects/${projectId}/settings` },
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
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
        {board ? (
          <span className="ml-auto text-xs text-[color:var(--tx3)]">
            {board.style === 'scrum' ? 'Scrum' : 'Kanban'}
          </span>
        ) : null}
      </header>

      <div className="min-h-0 flex-1">
        {tab === 'settings' ? (
          <ProjectSettingsPage projectId={projectId} />
        ) : tab === 'backlog' ? (
          <ProjectBacklogTab projectId={projectId} />
        ) : tab === 'insights' ? (
          <ProjectInsightsTab projectId={projectId} />
        ) : (
          <ProjectBoardTab projectId={projectId} />
        )}
      </div>
    </section>
  )
}
