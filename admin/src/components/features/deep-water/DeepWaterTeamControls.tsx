import { useState } from 'react'
import type { DeepWaterActiveRunConflict } from '@nessie/schemas'
import { useDeepWaterReadiness } from '../../../facades/deep-water/hooks'
import { useCancelResearchRun, useSetDeepWaterTeamEnabled } from '../../../facades/deep-water/mutations'
import { useActorNames } from '../../shared/ActorName'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { briefActionFailure } from './brief-action-errors'
import {
  TEAM_CONTROL_LABEL,
  deepWaterTeamControl,
  deepWaterTeamStatus,
  openResearchSentence,
  teamChangeFailure,
  type TeamChangeFailure,
} from './deep-water-team-copy'
import { useIntentActionId } from './useIntentActionId'

/**
 * DeepWater for this team, on its `/apps/deep-water` hero (nessie.md §7.7
 * doorways; amendments N8.5, N9): where it stands, and for a team owner the one
 * change there is to make — turn it on, turn it off, or update it to the
 * current research tools. A change an open research would break is refused
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
  const teamEnabled = readiness.product?.teamEnablement?.enabled === true
  const control = deepWaterTeamControl(readiness.state, teamEnabled, readiness.viewerIsOwner)

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
      {control ? (
        <div>
          <button
            className={`admin-button ${control === 'turn_off' ? 'admin-button-secondary' : 'admin-button-primary'}`}
            data-testid="deep-water-team-control"
            disabled={setEnabled.isPending}
            onClick={() => (control === 'turn_off' ? setConfirmingOff(true) : change(true))}
            type="button"
          >
            {setEnabled.isPending && control !== 'turn_off' ? 'Working…' : TEAM_CONTROL_LABEL[control]}
          </button>
        </div>
      ) : null}
      {failure?.kind === 'message' ? (
        <p className="text-sm text-[color:var(--danger-text)]" role="alert">{failure.message}</p>
      ) : null}
      {failure?.kind === 'open_research' ? (
        <OpenResearch
          canCancel={readiness.viewerCanChangeTeam}
          onCancelled={() => setFailure(null)}
          run={failure.run}
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
 * F3); an owner who may not read the research learns only that it is
 * cancelled.
 */
const OpenResearch = ({ canCancel, onCancelled, run }: {
  canCancel: boolean
  onCancelled: () => void
  run: DeepWaterActiveRunConflict
}) => {
  const resolveActor = useActorNames()
  const cancel = useCancelResearchRun()
  const actionId = useIntentActionId()
  const [error, setError] = useState<string | null>(null)
  const requester = run.requestedByUserId ? resolveActor('user', run.requestedByUserId) : null

  const cancelRun = () => {
    setError(null)
    const id = actionId.take({ cancel: run.id })
    cancel.mutate({ actionId: id, runId: run.id }, {
      onError: (failure) => {
        const read = briefActionFailure(failure)
        actionId.settle(read.retrySameAction)
        setError(read.message)
      },
      onSuccess: () => {
        actionId.settle(false)
        onCancelled()
      },
    })
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--sep)] p-3"
      data-testid="deep-water-open-research"
      role="alert"
    >
      <p className="text-sm text-[color:var(--tx)]">
        {openResearchSentence(run, requester?.named ? requester.name : null, canCancel)}
      </p>
      {canCancel ? (
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
