import { useState } from 'react'
import type { DeepWaterActiveRunConflict } from '@nessie/schemas'
import { useDeepWaterReadiness, useResearchRun } from '../../../facades/deep-water/hooks'
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
  deepWaterTeamControls,
  deepWaterTeamStatus,
  openResearchSentence,
  teamChangeFailure,
  type OpenResearchStanding,
  type TeamChangeFailure,
} from './deep-water-team-copy'
import { isResearchFinished } from './research-presentation'
import { useIntentActionId } from './useIntentActionId'

/**
 * DeepWater for this team, on its `/apps/deep-water` hero (nessie.md §7.7
 * doorways; amendments N8.5, N9): where it stands, and for a team owner the
 * changes there are to make — turn it on, turn it off, or update it to the
 * current research tools (a team that needs updating can also be turned off
 * without updating it first). A change an open research would break is refused
 * naming that research by who started it and where it stands (never its
 * question), with Cancel beside it, so the owner is never sent to ask an agent
 * to do it. The readiness screen behind the composer's Research button sends
 * owners here.
 */

export const DeepWaterTeamControls = () => {
  const readiness = useDeepWaterReadiness()
  const setEnabled = useSetDeepWaterTeamEnabled()
  const [confirmingOff, setConfirmingOff] = useState(false)
  const [failure, setFailure] = useState<TeamChangeFailure | null>(null)
  // Research this owner has asked to cancel, by run id. A cancel is accepted
  // before DeepWater has stopped the research, so trying the change again
  // meanwhile is refused by the same research: it is then said to be stopping,
  // and Cancel is not offered a second time.
  const [cancelRequested, setCancelRequested] = useState<ReadonlySet<string>>(() => new Set())
  const teamEnabled = readiness.product?.teamEnablement?.enabled === true
  const controls = deepWaterTeamControls(readiness.state, teamEnabled, readiness.viewerIsOwner)

  if (readiness.isLoading) return null

  const change = (enabled: boolean) => {
    setFailure(null)
    setEnabled.mutate(enabled, {
      onError: (error) => setFailure(teamChangeFailure(error)),
      // Refused or done, the confirm has had its answer; a refusal is said on
      // the hero, beside the research that caused it.
      onSettled: () => setConfirmingOff(false),
    })
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3" data-state={readiness.state} data-testid="deep-water-team-controls">
      <p className="text-sm text-[color:var(--tx2)]">
        {deepWaterTeamStatus(readiness.state, teamEnabled, readiness.viewerIsOwner)}
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
          cancelRequested={cancelRequested.has(failure.run.id)}
          key={failure.run.id}
          onCancelRequested={() => setCancelRequested((current) => new Set(current).add(failure.run.id))}
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
 * block stays, saying the research is stopping, until it has: an owner who may
 * read the research sees it stop here (its view is refreshed by the realtime
 * update); one who may not learns it from trying the change again.
 */
const OpenResearch = ({ canCancel, cancelRequested, onCancelRequested, run, viewerIsOwner }: {
  canCancel: boolean
  cancelRequested: boolean
  onCancelRequested: () => void
  run: DeepWaterActiveRunConflict
  viewerIsOwner: boolean
}) => {
  const resolveActor = useActorNames()
  const cancel = useCancelResearchRun()
  const actionId = useIntentActionId()
  const [error, setError] = useState<string | null>(null)
  const [stoppedOnAnswer, setStoppedOnAnswer] = useState(false)
  // A 404 is the answer for an owner who may not read the research: nothing to watch.
  const watched = useResearchRun(cancelRequested ? run.id : null)
  const watchedStopped = watched.data?.id === run.id && isResearchFinished(watched.data.status)
  const requester = run.requestedByUserId ? resolveActor('user', run.requestedByUserId) : null

  const standing: OpenResearchStanding = stoppedOnAnswer || watchedStopped
    ? 'stopped'
    : cancelRequested
      ? 'cancel_requested'
      : canCancel ? 'can_cancel' : 'cannot_cancel'

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
      {standing === 'can_cancel' ? (
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-danger admin-button-compact"
            disabled={cancel.isPending}
            onClick={cancelRun}
            type="button"
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel this research'}
          </button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-[color:var(--danger-text)]">{error}</p> : null}
    </div>
  )
}
