import { Navigate } from 'react-router-dom'
import { EmptyState } from '../components/shared/EmptyState'
import { useProjects } from '../facades/projects/hooks'

// /projects has no aggregate board any more — land on the first project's board.
export const ProjectsIndexPage = () => {
  const { data: projects = [], isLoading } = useProjects()
  if (isLoading) return null
  const first = projects[0]
  if (first) return <Navigate replace to={`/projects/${first.id}/board`} />
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState>No projects yet.</EmptyState>
    </div>
  )
}
