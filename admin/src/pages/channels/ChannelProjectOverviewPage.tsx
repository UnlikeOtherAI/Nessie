import { useParams } from 'react-router-dom'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { AdminPageHeader } from '../../components/shared/AdminPageHeader'
import { useProjects } from '../../facades/projects/hooks'

export const ChannelProjectOverviewPage = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: projects = [] } = useProjects()

  if (!projectId) return null

  const projectName = projects.find((project) => project.id === projectId)?.name ?? 'Project'

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader title={projectName} />
      <div className="min-h-0 flex-1">
        <ProjectDashboard projectId={projectId} />
      </div>
    </section>
  )
}
