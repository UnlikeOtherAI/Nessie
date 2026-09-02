import type { AgentTriggerActivityRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'

/**
 * What a trigger is doing, in one chip.
 *
 * **The count is the answer to "what if two are running at once".** A trigger
 * fires by writing a delivery, and a delivery carries at most one run, so the
 * server hands over a list. This renders its length rather than collapsing it
 * into a flag — two simultaneous executions read as "2 running", not as an
 * indicator that lies in either direction about the other one.
 *
 * When nothing is running the chip reports how the last run *finished*, which
 * is what turns the row green. No activity at all renders nothing: a trigger
 * that has never run has no outcome to state, and inventing "idle" for it just
 * adds a chip to every row.
 */

const Spinner = () => (
  <span
    aria-hidden="true"
    className="h-3 w-3 flex-shrink-0 animate-spin rounded-full border border-[var(--overlay-strong)] border-t-[color:var(--thinking)]"
  />
)

export const TriggerRunState = ({
  activity,
}: {
  activity: AgentTriggerActivityRecord | undefined
}) => {
  if (!activity) return null

  const runningCount = activity.running.length
  if (runningCount > 0) {
    return (
      <Pill data-testid="trigger-run-state" tone="accent">
        <span className="inline-flex items-center gap-1.5">
          <Spinner />
          {runningCount > 1 ? `${runningCount} running` : 'Running'}
        </span>
      </Pill>
    )
  }

  if (!activity.lastOutcome) return null

  const tone = activity.lastOutcome === 'completed'
    ? 'success'
    : activity.lastOutcome === 'failed'
      ? 'danger'
      : 'muted'
  const label = activity.lastOutcome === 'completed'
    ? 'Succeeded'
    : activity.lastOutcome === 'failed'
      ? 'Failed'
      : 'Cancelled'

  return (
    <Pill data-testid="trigger-run-state" tone={tone}>
      {label}
    </Pill>
  )
}
