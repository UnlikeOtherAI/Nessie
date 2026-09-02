import {
  useBlockWorkflowStepRun,
  useCancelWorkflowRun,
  useRetryWorkflowRun,
  useSkipWorkflowStepRun,
  useUnblockWorkflowStepRun,
  useWorkflowRun,
} from '../../../facades/workflows/hooks'
import { EmptyState } from '../../shared/EmptyState'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { Notice } from '../../primitives/Notice'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import {
  formatDuration,
  formatTimestamp,
  getRunTone,
  getStepStatusColor,
  isActiveRun,
  isTerminalRun,
} from './presentation'

/**
 * Run detail: a step timeline with status dots and durations. Payload JSON is
 * collapsed by default (it is audit data, not the primary read), and step
 * actions (skip / block / unblock) appear only when they can actually apply.
 */

type WorkflowRunDetailProps = {
  workflowRunId: string
}

const JsonDetails = ({ label, value }: { label: string; value: unknown }) => {
  const isEmpty =
    value === undefined ||
    value === null ||
    (typeof value === 'object' && Object.keys(value as object).length === 0)
  if (isEmpty) return null

  return (
    <details>
      <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)] hover:text-[color:var(--tx2)]">
        {label}
      </summary>
      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--sep)] bg-[var(--scrim-strong)] p-3 text-xs leading-5 text-[color:var(--tx2)]">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

const stepActionButton =
  'admin-button admin-button-secondary admin-button-compact'

export const WorkflowRunDetail = ({ workflowRunId }: WorkflowRunDetailProps) => {
  const runQuery = useWorkflowRun(workflowRunId)
  const cancelRun = useCancelWorkflowRun()
  const retryRun = useRetryWorkflowRun()
  const skipStep = useSkipWorkflowStepRun()
  const blockStep = useBlockWorkflowStepRun()
  const unblockStep = useUnblockWorkflowStepRun()

  return (
    <QueryState
      errorLabel="This run could not be loaded."
      loadingLabel="Loading run…"
      query={runQuery}
    >
      {() => {
        if (!runQuery.data) return null
        const { run, steps } = runQuery.data
        const duration = formatDuration(run.startedAt ?? run.createdAt, run.finishedAt)

        return (
          <div className="grid max-w-3xl gap-5">
            <div>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-[var(--tx)]">
                      Run {run.id.slice(0, 8)}
                    </h2>
                    <Pill tone={getRunTone(run.status)}>{run.status}</Pill>
                  </div>
                  <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                    started {formatTimestamp(run.startedAt ?? run.createdAt)}
                    {run.finishedAt ? ` · finished ${formatTimestamp(run.finishedAt)}` : ''}
                    {duration ? ` · ${duration}` : ''}
                  </div>
                  {run.retriedFromWorkflowRunId ? (
                    <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                      retry of {run.retriedFromWorkflowRunId.slice(0, 8)}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  {isActiveRun(run.status) ? (
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={cancelRun.isPending}
                      onClick={() => cancelRun.mutate({ workflowRunId: run.id })}
                      type="button"
                    >
                      {cancelRun.isPending ? 'Cancelling…' : 'Cancel'}
                    </button>
                  ) : null}
                  {isTerminalRun(run.status) ? (
                    <button
                      className="admin-button admin-button-primary"
                      disabled={retryRun.isPending}
                      onClick={() => retryRun.mutate({ workflowRunId: run.id })}
                      type="button"
                    >
                      {retryRun.isPending ? 'Retrying…' : 'Retry'}
                    </button>
                  ) : null}
                </div>
              </div>
              {run.errorMessage ? (
                <Notice className="mt-3" radius="lg" size="sm" tone="danger">
                  {run.errorMessage}
                </Notice>
              ) : null}
              <div className="mt-3 grid gap-2">
                <JsonDetails label="Run input" value={run.input} />
                <JsonDetails label="Run output" value={run.output} />
              </div>
            </div>

            <section>
              <SectionLabel>Steps</SectionLabel>
              {steps.length === 0 ? (
                <EmptyState className="mt-3">No step runs recorded yet.</EmptyState>
              ) : (
                <RowList className="mt-3" label="Steps">
                  {steps.map((step) => {
                    const canSkip =
                      isActiveRun(run.status) &&
                      (step.status === 'pending' || step.status === 'blocked')
                    const canBlock = isActiveRun(run.status) && step.status === 'pending'
                    const canUnblock = isActiveRun(run.status) && step.status === 'blocked'
                    const stepDuration = formatDuration(step.startedAt, step.finishedAt)

                    return (
                      <Row
                        key={step.id}
                        leading={
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: getStepStatusColor(step.status) }}
                            title={step.status}
                          />
                        }
                        subtitle={`${step.stepType}${stepDuration ? ` · ${stepDuration}` : ''}`}
                        title={`${step.sequence + 1}. ${step.title}`}
                        trailing={
                          <>
                            <span className="text-xs text-[color:var(--tx3)]">
                              {step.status}
                            </span>
                            {canSkip ? (
                              <button
                                className={stepActionButton}
                                disabled={skipStep.isPending}
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
                            ) : null}
                            {canBlock ? (
                              <button
                                className={stepActionButton}
                                disabled={blockStep.isPending}
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
                            ) : null}
                            {canUnblock ? (
                              <button
                                className={stepActionButton}
                                disabled={unblockStep.isPending}
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
                            ) : null}
                          </>
                        }
                      >
                        {step.errorMessage ? (
                          <div className="mt-1 text-xs text-[var(--danger-text)]">
                            {step.errorMessage}
                          </div>
                        ) : null}
                        {step.agentRunId || step.taskId ? (
                          <div className="mt-1 text-xs text-[color:var(--tx3)]">
                            {step.agentRunId ? `agent run ${step.agentRunId.slice(0, 8)}` : ''}
                            {step.agentRunId && step.taskId ? ' · ' : ''}
                            {step.taskId ? `task ${step.taskId.slice(0, 8)}` : ''}
                          </div>
                        ) : null}
                        <div className="mt-2 grid gap-1.5">
                          <JsonDetails label="Input" value={step.input} />
                          <JsonDetails label="Output" value={step.output} />
                        </div>
                      </Row>
                    )
                  })}
                </RowList>
              )}
            </section>
          </div>
        )
      }}
    </QueryState>
  )
}
