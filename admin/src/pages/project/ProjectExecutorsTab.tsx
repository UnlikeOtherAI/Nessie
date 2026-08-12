import { Link } from 'react-router-dom'
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
    <div className="min-h-0 overflow-y-auto p-6">
      <div className="mx-auto grid max-w-4xl gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--tx)]">Project executors</h2>
            <p className="mt-1 max-w-2xl text-sm text-[color:var(--tx3)]">
              These paired machines are available only to entitled work in this exact project.
              Agent operation access is managed in the shared Executors surface.
            </p>
          </div>
          <Link
            className="admin-button admin-button-primary"
            to={`/agents/executors?create=project&scopeProjectId=${projectId}`}
          >
            New project executor
          </Link>
        </header>

        {executorsQuery.isLoading ? <p className="text-sm text-[color:var(--tx3)]">Loading executors…</p> : null}
        {executorsQuery.isError ? <p className="text-sm text-[color:var(--danger-text)]">Unable to load project executors.</p> : null}
        {!executorsQuery.isLoading && !executorsQuery.isError && executors.length === 0 ? (
          <section className="admin-card p-5 text-sm text-[color:var(--tx3)]">
            No executor is configured for this project. Pair one here when the work needs a governed
            sandbox or coding session.
          </section>
        ) : null}
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
      </div>
    </div>
  )
}
