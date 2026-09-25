import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/shared/EmptyState'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useExecutors } from '../../facades/executors/hooks'

type ProjectExecutorsTabProps = {
  projectId: string
}

export const ProjectExecutorsTab = ({ projectId }: ProjectExecutorsTabProps) => {
  const executorsQuery = useExecutors(projectId)
  const executors = executorsQuery.data ?? []

  return (
    <PageBody>
      <Section
        actions={
          <Link
            className="admin-button admin-button-primary"
            to="/agents/executors"
          >
            Share an executor
          </Link>
        }
        description="Executors shared with this project or its whole team. Open an executor to manage its agents and sharing."
        title="Project executors"
      >
        <QueryState
          errorLabel="Couldn't load project executors."
          loadingLabel="Loading executors…"
          query={executorsQuery}
        >
          {() =>
            executors.length === 0 ? (
              <EmptyState>
                No executor is shared with this project. Open an executor’s Permissions tab to share it.
              </EmptyState>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {executors.map((executor) => (
                  <Link
                    className="admin-card grid gap-1 p-4 transition-colors hover:bg-[color:var(--overlay-weak)]"
                    key={executor.id}
                    to={`/agents/executors/${executor.id}`}
                  >
                    <span className="text-sm font-semibold text-[color:var(--tx)]">{executor.label}</span>
                    <span className="text-xs text-[color:var(--tx3)]">
                      {executor.status} · {executor.profiles.join(', ') || 'Waiting for machine capabilities'}
                    </span>
                    <span className="text-xs text-[color:var(--tx2)]">Open executor</span>
                  </Link>
                ))}
              </div>
            )
          }
        </QueryState>
      </Section>
    </PageBody>
  )
}
