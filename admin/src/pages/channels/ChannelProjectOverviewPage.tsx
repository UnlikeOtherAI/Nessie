import { useParams } from 'react-router-dom'
import { ProjectDashboard } from '../../components/features/projects/ProjectDashboard'
import { ProjectPageHeader } from '../../components/features/projects/ProjectPageHeader'
import { useProjects } from '../../facades/projects/hooks'

export const ChannelProjectOverviewPage = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: projects = [] } = useProjects()

  if (!projectId) return null

  const project = projects.find((candidate) => candidate.id === projectId)

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ProjectPageHeader project={project} />
      <div className="min-h-0 flex-1">
        <ProjectDashboard projectId={projectId} />
      </div>
    </section>
  )
}
