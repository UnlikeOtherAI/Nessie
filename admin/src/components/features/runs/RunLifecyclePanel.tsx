import {
  useActiveRuns,
  useCancelRun,
  useContinueRun,
  useRestartRun,
} from '../../../facades/runs/hooks'
import { useToasts } from '../../../providers/ToastProvider'

const statusBadge = (status: string) => (
  <span
    className={[
      'rounded bg-[color:var(--accent-soft)] px-1.5 py-0.5',
      'text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--thinking)]',
    ].join(' ')}
  >
    {status.replace(/_/g, ' ')}
  </span>
)

const formatTime = (value: string | null): string =>
  value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

const rowClass = [
  'flex items-center gap-3 rounded-md border border-[color:var(--sep)]',
  'bg-[var(--overlay-weak)] px-3 py-2',
].join(' ')

const buttonClass = [
  'rounded-md border border-[color:var(--sep)] px-2.5 py-1 text-xs font-medium',
  'text-[color:var(--tx2)] transition hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ')

const primaryButtonClass = [
  'rounded-md border border-[color:var(--accent)] bg-[var(--accent)] px-2.5 py-1',
  'text-xs font-semibold text-[var(--on-accent)] transition hover:opacity-90',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ')

export const RunLifecyclePanel = () => {
  const { data, isLoading } = useActiveRuns()
  const cancelRun = useCancelRun()
  const restartRun = useRestartRun()
  const continueRun = useContinueRun()
  const { pushToast } = useToasts()

  const active = data?.runs ?? []
  const restartable = data?.restartable ?? []

  // The API authors the meaning of every refusal (already continued, agent
  // busy, handoff-managed), so the toast repeats its message verbatim.
  const onContinue = (runId: string) => {
    continueRun.mutate(runId, {
      onError: (error) => {
        pushToast({ body: error.message, title: 'Could not continue the run' })
      },
      onSuccess: () => {
        pushToast({ body: 'The agent picks up where it stopped.', title: 'Run continued' })
      },
    })
  }

  return (
    <section className="flex flex-col gap-4" data-testid="run-lifecycle-panel">
      <div>
        <div className="admin-sec-hdr mt-1">
          <span>Active runs</span>
          <span
            className={[
              'ml-auto rounded bg-[var(--overlay-weak)] px-1.5 py-0.5 text-[10px]',
              'font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
          >
            {active.length}
          </span>
        </div>
        {isLoading ? (
          <p className="px-1 py-2 text-sm text-[color:var(--tx3)]">Loading runs…</p>
        ) : active.length === 0 ? (
          <p className="px-1 py-2 text-sm text-[color:var(--tx3)]">No runs are executing right now.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {active.map((run) => (
              <li key={run.id} className={rowClass}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-[color:var(--tx)]">{run.agentName}</span>
                    {statusBadge(run.status)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[color:var(--tx3)]">
                    started {formatTime(run.startedAt)} · {run.toolCallCount} tool calls
                  </div>
                </div>
                <button
                  className={buttonClass}
                  disabled={run.cancelRequested || cancelRun.isPending}
                  onClick={() => cancelRun.mutate(run.id)}
                  type="button"
                >
                  {run.cancelRequested ? 'Cancelling…' : 'Cancel'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="admin-sec-hdr mt-1">
          <span>Recently ended</span>
          <span
            className={[
              'ml-auto rounded bg-[var(--overlay-weak)] px-1.5 py-0.5 text-[10px]',
              'font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
          >
            {restartable.length}
          </span>
        </div>
        {restartable.length === 0 ? (
          <p className="px-1 py-2 text-sm text-[color:var(--tx3)]">No failed or cancelled runs to restart.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {restartable.map((run) => (
              <li key={run.id} className={rowClass}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-[color:var(--tx)]">{run.agentName}</span>
                    {statusBadge(run.status)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[color:var(--tx3)]">
                    ended {formatTime(run.finishedAt)} · {run.toolCallCount} tool calls
                    {run.checkpointId ? ' · working state saved' : ''}
                  </div>
                </div>
                {/* A saved checkpoint makes Continue the primary action; restart
                    stays available and does not consume the checkpoint. */}
                {run.checkpointId ? (
                  <button
                    className={primaryButtonClass}
                    disabled={continueRun.isPending}
                    onClick={() => onContinue(run.id)}
                    type="button"
                  >
                    Continue
                  </button>
                ) : null}
                <button
                  className={buttonClass}
                  disabled={restartRun.isPending}
                  onClick={() => restartRun.mutate(run.id)}
                  type="button"
                >
                  Restart
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
