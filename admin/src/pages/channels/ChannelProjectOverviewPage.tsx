import { useParams } from 'react-router-dom'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { useProjects } from '../../facades/projects/hooks'
import { MobileMenuButton } from '../../layouts/admin-shell/MobileMenuButton'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const ChannelProjectOverviewPage = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: projects = [] } = useProjects()

  if (!projectId) return null

  const projectName = projects.find((project) => project.id === projectId)?.name ?? 'Project'

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className={sectionTitle}>{projectName}</div>
      </header>
      <div className="min-h-0 flex-1">
        <ProjectDashboard projectId={projectId} />
      </div>
    </section>
  )
}
