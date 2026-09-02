import { Link } from 'react-router-dom'
import { EmptyState } from '../../components/shared/EmptyState'
import { PageBody, Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'
import { useExecutors } from '../../facades/executors/hooks'

type ProjectExecutorsTabProps = {
  projectId: string
}

export const ProjectExecutorsTab = ({ projectId }: ProjectExecutorsTabProps) => {
  const executorsQuery = useExecutors()
  const executors = (executorsQuery.data ?? []).filter(
    (executor) => executor.scope.kind === 'project' && executor.scope.projectId === projectId,
  )

  return (
    <PageBody width="regular">
      <Section
        actions={
          <Link
            className="admin-button admin-button-primary"
            to={`/agents/executors?create=project&scopeProjectId=${projectId}`}
          >
            New project executor
          </Link>
        }
        description="These paired machines are available only to entitled work in this exact project. Agent operation access is managed in the shared Executors surface."
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
                No executor is configured for this project. Pair one here when the work needs a
                governed sandbox or coding session.
              </EmptyState>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {executors.map((executor) => (
                  <Link
                    className="admin-card grid gap-1 p-4 transition-colors hover:bg-[color:var(--overlay-weak)]"
                    key={executor.id}
                    to={`/agents/executors?executorId=${executor.id}`}
                  >
                    <span className="text-sm font-semibold text-[color:var(--tx)]">{executor.label}</span>
                    <span className="text-xs text-[color:var(--tx3)]">
                      {executor.status} · {executor.profiles.join(', ') || 'Awaiting descriptor review'}
                    </span>
                    <span className="text-xs text-[color:var(--tx2)]">Open access and operations</span>
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
