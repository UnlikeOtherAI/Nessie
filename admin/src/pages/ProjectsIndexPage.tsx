import { Navigate } from 'react-router-dom'
import { EmptyState } from '../components/shared/EmptyState'
import { QueryState } from '../components/shared/QueryState'
import { useProjects } from '../facades/projects/hooks'

// /projects has no aggregate board any more — land on the first project's
// board. `QueryState` tells a real failure apart from the legitimately-empty
// case (05-F4): a failed read used to fall through to the same `data = []`
// default as "no projects yet" and render the identical empty sentence.
export const ProjectsIndexPage = () => {
  const projectsQuery = useProjects()
  const first = (projectsQuery.data ?? [])[0]

  return (
    <div className="flex h-full items-center justify-center p-8">
      <QueryState
        errorLabel="Projects could not be loaded."
        loadingLabel="Loading projects…"
        query={projectsQuery}
      >
        {() => (first
          ? <Navigate replace to={`/projects/${first.id}/board`} />
          : <EmptyState>No projects yet.</EmptyState>)}
      </QueryState>
    </div>
  )
}
