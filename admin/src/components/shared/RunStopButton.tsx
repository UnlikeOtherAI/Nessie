import { useState, type MouseEvent } from 'react'
import { faStop } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

import { useCancelRun } from '../../facades/runs/hooks'
import { SharedActionButton } from './ActionToolbar'

type RunStopButtonProps = {
  agentName: string
  runId: string
}

/**
 * Stop for a live run, drawn where a person watches it: the thinking bubble
 * and the agent's status pill. A caller renders it only while the run is live
 * (`pending`, `running`, `waiting_approval`, `waiting_input`) and drops it when
 * the run leaves that state, which is what ends "Stopping…".
 *
 * Stop is cooperative — `POST /api/runs/:runId/cancel` flags a running run and
 * the loop ends it between model iterations and tool batches — so the press
 * cannot end the run on the spot. The pressed state holds until the caller
 * stops rendering this, and a refusal puts the control back with the
 * server's reason beside it.
 */
export const RunStopButton = ({ agentName, runId }: RunStopButtonProps) => {
  const cancelRun = useCancelRun()
  // Keyed by run, not a boolean: a caller that keeps this mounted across two
  // runs (the agent header) must offer Stop again for the next one.
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stopping = stoppingRunId === runId

  const stop = (event: MouseEvent<HTMLButtonElement>) => {
    // A feed row toggles its hover actions on a click that reaches it; a Stop
    // is its own affordance and must not do that too.
    event.stopPropagation()
    if (stopping) return
    setError(null)
    setStoppingRunId(runId)
    cancelRun.mutate(runId, {
      onError: (cause) => {
        setStoppingRunId(null)
        setError(cause.message)
      },
    })
  }

  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1.5" data-testid="run-stop">
      {stopping ? (
        <span
          aria-live="polite"
          className="text-xs font-semibold text-[color:var(--tx3)]"
          data-testid="run-stop-pending"
        >
          Stopping…
        </span>
      ) : null}
      {error ? (
        <span className="text-xs text-[color:var(--danger-text)]" role="alert">
          {error}
        </span>
      ) : null}
      <SharedActionButton
        aria-disabled={stopping ? 'true' : undefined}
        aria-label={stopping ? `Stopping ${agentName}…` : `Stop ${agentName}`}
        className={stopping ? 'cursor-default opacity-50' : undefined}
        data-testid="run-stop-button"
        onClick={stop}
        title={stopping ? 'Stopping…' : 'Stop'}
        type="button"
      >
        <FontAwesomeIcon aria-hidden="true" icon={faStop} />
      </SharedActionButton>
    </span>
  )
}
