import {
  useBlockWorkflowStepRun,
  useCancelWorkflowRun,
  useRetryWorkflowRun,
  useSkipWorkflowStepRun,
  useUnblockWorkflowStepRun,
  useWorkflowRun,
} from '../../../facades/workflows/hooks'
import {
  dangerPill,
  infoPill,
  isActiveRun,
  isTerminalRun,
  JsonBlock,
  runStatusClass,
  sectionTitle,
  stepActionPill,
  stepStatusClass,
  formatTimestamp,
} from './presentation'

type WorkflowRunDetailProps = {
  workflowRunId: string
}

export const WorkflowRunDetail = ({ workflowRunId }: WorkflowRunDetailProps) => {
  const { data, isLoading } = useWorkflowRun(workflowRunId)
  const cancelRun = useCancelWorkflowRun()
  const retryRun = useRetryWorkflowRun()
  const skipStep = useSkipWorkflowStepRun()
  const blockStep = useBlockWorkflowStepRun()
  const unblockStep = useUnblockWorkflowStepRun()

  if (isLoading || !data) {
    return (
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4 text-[color:var(--tx3)]">
        Loading run…
      </div>
    )
  }

  const { run, steps } = data

  return (
    <div className="grid gap-4">
      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={sectionTitle}>Run detail</div>
            <div className="mt-1 text-sm font-semibold text-white">
              {run.id.slice(0, 8)} ·{' '}
              <span className={runStatusClass(run.status)}>{run.status}</span>
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              started {formatTimestamp(run.startedAt ?? run.createdAt)} · finished{' '}
              {formatTimestamp(run.finishedAt)}
            </div>
            {run.retriedFromWorkflowRunId ? (
              <div className="text-xs text-[color:var(--tx3)]">
                retried from {run.retriedFromWorkflowRunId.slice(0, 8)}
              </div>
            ) : null}
            {run.errorMessage ? (
              <div className="mt-1 text-xs text-rose-300">{run.errorMessage}</div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className={dangerPill}
              disabled={!isActiveRun(run.status) || cancelRun.isPending}
              onClick={() => cancelRun.mutate({ workflowRunId: run.id })}
              type="button"
            >
              Cancel
            </button>
            <button
              className={infoPill}
              disabled={!isTerminalRun(run.status) || retryRun.isPending}
              onClick={() => retryRun.mutate({ workflowRunId: run.id })}
              type="button"
            >
              Retry
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
        <div className={sectionTitle}>Run payload</div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <JsonBlock label="Input" value={run.input} />
          <JsonBlock label="Output" value={run.output} />
        </div>
      </div>

      <div className="grid gap-2">
        {steps.map((step) => {
          const canSkip =
            isActiveRun(run.status) &&
            (step.status === 'pending' || step.status === 'blocked')
          const canBlock = isActiveRun(run.status) && step.status === 'pending'
          const canUnblock = isActiveRun(run.status) && step.status === 'blocked'

          return (
            <div
              className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
              key={step.id}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-white">
                    {step.sequence + 1}. {step.title}
                  </div>
                  <div className="text-xs text-[color:var(--tx3)]">
                    {step.stepKey} · {step.stepType}
                  </div>
                </div>
                <span
                  className={`text-[11px] font-semibold uppercase tracking-[0.15em] ${stepStatusClass(step.status)}`}
                >
                  {step.status}
                </span>
              </div>
              {step.errorMessage ? (
                <div className="mt-1 text-xs text-rose-300">{step.errorMessage}</div>
              ) : null}
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <JsonBlock label="Step input" value={step.input} />
                <JsonBlock label="Step output" value={step.output} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className={stepActionPill}
                  disabled={!canSkip || skipStep.isPending}
                  onClick={() =>
                    skipStep.mutate({
                      workflowStepRunId: step.id,
                      workflowRunId: run.id,
                    })
                  }
                  type="button"
                >
                  Skip
                </button>
                <button
                  className={stepActionPill}
                  disabled={!canBlock || blockStep.isPending}
                  onClick={() =>
                    blockStep.mutate({
                      workflowStepRunId: step.id,
                      workflowRunId: run.id,
                    })
                  }
                  type="button"
                >
                  Block
                </button>
                <button
                  className={stepActionPill}
                  disabled={!canUnblock || unblockStep.isPending}
                  onClick={() =>
                    unblockStep.mutate({
                      workflowStepRunId: step.id,
                      workflowRunId: run.id,
                    })
                  }
                  type="button"
                >
                  Unblock
                </button>
              </div>
            </div>
          )
        })}
        {steps.length === 0 ? (
          <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4 text-center text-sm text-[color:var(--tx3)]">
            No step runs recorded yet.
          </div>
        ) : null}
      </div>
    </div>
  )
}
