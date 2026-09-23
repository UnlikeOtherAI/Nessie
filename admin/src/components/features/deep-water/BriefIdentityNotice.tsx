import { useState } from 'react'
import type { DeepWaterBriefView } from '@nessie/schemas'
import { useIsOwner } from '../../../facades/auth/hooks'
import { useRetryResearchDelivery } from '../../../facades/deep-water/mutations'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Notice } from '../../primitives/Notice'
import { briefActionFailure } from './brief-action-errors'
import { useIntentActionId } from './useIntentActionId'

/**
 * "Sign in again to continue this brief" (amendments-fable F4). DeepWater
 * could not be asked about this brief with the sign-in it was opened with —
 * the requester signed out, or their organisation sign-in changed — so the
 * watch stopped. The requester's next live action carries their current
 * sign-in and carries on: signing in again first, or, if they already have,
 * Retry (offered where the server says `viewer.canRetryDelivery`).
 *
 * It is the requester's, whoever is agreeing the brief. On an agent's brief
 * the worker tells them in the conversation to sign in again and choose Retry
 * so the agent can continue, and the brief they open from there says the same
 * and offers the same Retry. An agent's own actions are not theirs to redo,
 * so only the blocked brief — never an agent action's refusal — asks it.
 */

export const briefNeedsSignIn = (brief: DeepWaterBriefView): boolean =>
  brief.status === 'drafting'
  && (brief.delivery.blockedReason === 'requester_identity_changed'
    || (brief.origin.kind === 'person' && brief.pendingAction?.error?.code === 'identity_required'))

export const BriefIdentityNotice = ({ brief, meUserId }: { brief: DeepWaterBriefView; meUserId: string }) => {
  const { logout } = useAuthSession()
  const retry = useRetryResearchDelivery()
  const actionId = useIntentActionId()
  const viewerIsOwner = useIsOwner()
  const [error, setError] = useState<string | null>(null)
  const requester = brief.requestedByUserId !== null && brief.requestedByUserId === meUserId
  if (!requester || !briefNeedsSignIn(brief)) return null

  const carryOn = () => {
    setError(null)
    const id = actionId.take({ deliver: brief.id })
    retry.mutate({ actionId: id, runId: brief.id }, {
      onError: (failure) => {
        const read = briefActionFailure(failure, 'deliver', viewerIsOwner)
        actionId.settle(read.retrySameAction)
        setError(read.message)
      },
      onSuccess: () => actionId.settle(false),
    })
  }

  return (
    <Notice data-testid="research-brief-sign-in" role="status" size="sm" tone="warning">
      <div className="flex flex-col gap-2">
        <span>
          {brief.origin.kind === 'agent'
            ? 'Your sign-in has changed, so the agent can’t carry on with this brief. Sign in again to let it '
              + 'continue.'
            : 'Sign in again to continue this brief.'}
        </span>
        <div className="flex flex-wrap gap-2">
          <button className="admin-button admin-button-primary admin-button-compact" onClick={() => void logout()} type="button">
            Sign in again
          </button>
          {brief.viewer.canRetryDelivery ? (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={retry.isPending}
              onClick={carryOn}
              type="button"
            >
              I’ve signed in again — retry
            </button>
          ) : null}
        </div>
        {error ? <span role="alert">{error}</span> : null}
      </div>
    </Notice>
  )
}
