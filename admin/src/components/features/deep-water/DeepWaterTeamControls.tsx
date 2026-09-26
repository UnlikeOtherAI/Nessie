import { useRef, useState } from 'react'
import type { DeepWaterActiveRunConflict } from '@nessie/schemas'
import { isResearchNotFound, useDeepWaterReadiness, useResearchRun } from '../../../facades/deep-water/hooks'
import {
  hasResearchStopped,
  useCancelResearchRun,
  useSetDeepWaterTeamEnabled,
} from '../../../facades/deep-water/mutations'
import { useActorNames } from '../../shared/ActorName'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { briefActionFailure } from './brief-action-errors'
import {
  TEAM_CONTROL_LABEL,
  cancelOfferedAgain,
  deepWaterTeamControls,
  deepWaterTeamStatus,
  openResearchSentence,
  openResearchStanding,
  teamChangeFailure,
  type TeamChangeFailure,
} from './deep-water-team-copy'
import { isResearchFinished } from './research-presentation'
import { ResearchReadinessUnread } from './ResearchReadinessScreen'
import { useIntentActionId } from './useIntentActionId'

/**
 * DeepWater for this team, on its `/admin/apps/deep-water` hero (nessie.md §7.7
 * doorways; amendments N8.5, N9): where it stands, and for a team owner the
 * changes there are to make — turn it on, turn it off, or update it to the
 * current research tools (a team that needs updating can also be turned off
 * without updating it first). A change an open research would break is refused
 * naming that research by who started it and where it stands (never its
 * question), with Cancel beside it, so the owner is never sent to ask an agent
 * to do it. The readiness screen behind the composer's Research button sends
 * owners here. A verdict that could not be read says so, with Try again,
 * rather than offering to turn on a team that may already be on.
 */

export const DeepWaterTeamControls = () => {
  const readiness = useDeepWaterReadiness()
  const setEnabled = useSetDeepWaterTeamEnabled()
  const [confirmingOff, setConfirmingOff] = useState(false)
  const [failure, setFailure] = useState<TeamChangeFailure | null>(null)
  // Every refusal of a change, counted, and the research this owner has asked
  // to cancel, by run id, with the count it was asked at. A cancel is accepted
  // before DeepWater has stopped the research, so trying the change again
  // meanwhile is refused by the same research; whether that is the cancel
  // still on its way or one that did not go through, the research's own view
  // says — and for an owner who may not read it, a refusal since the cancel
  // is all there is to go on.
  const [refusals, setRefusals] = useState(0)
  // The count as of now, for a cancel accepted after a render that saw fewer.
  const refusalsSoFar = useRef(0)
  const [cancelRequested, setCancelRequested] = useState<ReadonlyMap<string, number>>(() => new Map())

  if (readiness.state === null) {
    return readiness.isError ? (
      <div className="flex max-w-2xl flex-col gap-3" data-testid="deep-water-team-controls">
        <ResearchReadinessUnread onRetry={readiness.retry} />
      </div>
    ) : null
  }
  const state = readiness.state
  const teamEnabled = readiness.product?.teamEnablement?.enabled === true
  const controls = deepWaterTeamControls(state, teamEnabled, readiness.viewerIsOwner)

  const change = (enabled: boolean) => {
    setFailure(null)
    setEnabled.mutate(enabled, {
      onError: (error) => {
        refusalsSoFar.current += 1
        setRefusals(refusalsSoFar.current)
        setFailure(teamChangeFailure(error))
      },
      // Refused or done, the confirm has had its answer; a refusal is said on
      // the hero, beside the research that caused it.
      onSettled: () => setConfirmingOff(false),
    })
  }

  const requestedAt = failure?.kind === 'open_research' ? cancelRequested.get(failure.run.id) : undefined

  return (
    <div className="flex max-w-2xl flex-col gap-3" data-state={state} data-testid="deep-water-team-controls">
      <p className="text-sm text-[color:var(--tx2)]">
        {deepWaterTeamStatus(state, teamEnabled, readiness.viewerIsOwner)}
      </p>
      {controls.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {controls.map((control) => (
            <button
              className={`admin-button ${control === 'turn_off' ? 'admin-button-secondary' : 'admin-button-primary'}`}
              data-control={control}
              data-testid="deep-water-team-control"
              disabled={setEnabled.isPending}
              key={control}
              onClick={() => (control === 'turn_off' ? setConfirmingOff(true) : change(true))}
              type="button"
            >
              {setEnabled.isPending && setEnabled.variables === true && control !== 'turn_off'
                ? 'Working…'
                : TEAM_CONTROL_LABEL[control]}
            </button>
          ))}
        </div>
      ) : null}
      {failure?.kind === 'message' ? (
        <p className="text-sm text-[color:var(--danger-text)]" role="alert">{failure.message}</p>
      ) : null}
      {failure?.kind === 'open_research' ? (
        <OpenResearch
          canCancel={readiness.viewerCanChangeTeam}
          cancelRequested={requestedAt !== undefined}
          key={failure.run.id}
          onCancelRequested={() => {
            const runId = failure.run.id
            setCancelRequested((current) => new Map(current).set(runId, refusalsSoFar.current))
          }}
          refusedAgain={requestedAt !== undefined && refusals > requestedAt}
          run={failure.run}
          viewerIsOwner={readiness.viewerIsOwner}
        />
      ) : null}
      <ConfirmDialog
        body={(
          <p>
            Agents lose their research tools, and nobody in this team can start research until it’s turned on
            again. Research that has finished stays in Documents.
          </p>
        )}
        confirmLabel={setEnabled.isPending ? 'Turning off…' : 'Turn off'}
        destructive
        onCancel={() => {
          if (!setEnabled.isPending) setConfirmingOff(false)
        }}
        onConfirm={() => change(false)}
        open={confirmingOff}
        pending={setEnabled.isPending}
        title="Turn off DeepWater for this team?"
      />
    </div>
  )
}

/**
 * The research that stopped the change, and an owner's Cancel for it — offered
 * on the verdict's cancel standing (`viewerCanChangeTeam`, owners and admins,
 * amendments N8.5). The cancel is the owner's own action (amendments-fable
 * F3). The API accepts it before DeepWater has stopped the research, so the
 * block stays, saying the research is stopping, until it has. An owner who may
 * read the research watches it here (its view is refreshed by the realtime
 * update): they see it stop, and a cancel that did not go through comes back
 * with its reason and Cancel offered again. One who may not read it learns
 * only from trying the change again, and is offered Cancel again then.
 */
const OpenResearch = ({ canCancel, cancelRequested, onCancelRequested, refusedAgain, run, viewerIsOwner }: {
  canCancel: boolean
  cancelRequested: boolean
  onCancelRequested: () => void
  refusedAgain: boolean
  run: DeepWaterActiveRunConflict
  viewerIsOwner: boolean
}) => {
  const resolveActor = useActorNames()
  const cancel = useCancelResearchRun()
  const actionId = useIntentActionId()
  const [error, setError] = useState<string | null>(null)
  const [stoppedOnAnswer, setStoppedOnAnswer] = useState(false)
  const watched = useResearchRun(run.id)
  const view = watched.data?.id === run.id ? watched.data : null
  const requester = run.requestedByUserId ? resolveActor('user', run.requestedByUserId) : null

  const standing = openResearchStanding({
    canCancel,
    cancelRequested,
    refusedAgain,
    stoppedOnAnswer,
    unreadable: watched.isError && isResearchNotFound(watched.error),
    view: view ? { cancelFailed: view.cancelFailure !== null, finished: isResearchFinished(view.status) } : null,
  })
  const offerCancel = standing === 'can_cancel' || cancelOfferedAgain(standing)

  const cancelRun = () => {
    setError(null)
    const id = actionId.take({ cancel: run.id })
    cancel.mutate({ actionId: id, runId: run.id }, {
      onError: (failure) => {
        const read = briefActionFailure(failure, 'cancel', viewerIsOwner)
        actionId.settle(read.retrySameAction)
        setError(read.message)
      },
      onSuccess: (answer) => {
        actionId.settle(false)
        onCancelRequested()
        if (hasResearchStopped(answer)) setStoppedOnAnswer(true)
      },
    })
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--sep)] p-3"
      data-standing={standing}
      data-testid="deep-water-open-research"
      role={standing === 'stopped' ? 'status' : 'alert'}
    >
      <p className="text-sm text-[color:var(--tx)]">
        {openResearchSentence(run, requester?.named ? requester.name : null, standing)}
      </p>
      {standing === 'cancel_failed' && view?.cancelFailure ? (
        <p className="text-sm text-[color:var(--danger-text)]" data-testid="deep-water-cancel-failure">
          {view.cancelFailure.message}
        </p>
      ) : null}
      {offerCancel ? (
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-danger admin-button-compact"
            disabled={cancel.isPending}
            onClick={cancelRun}
            type="button"
          >
            {cancel.isPending ? 'Cancelling…' : standing === 'can_cancel' ? 'Cancel this research' : 'Cancel again'}
          </button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-[color:var(--danger-text)]">{error}</p> : null}
    </div>
  )
}
