import { useEffect, useState } from 'react'
import type { TeamInvitationRecord } from '@nessie/schemas'

import { Dialog } from '../../shared/Dialog'
import { FormError } from '../../shared/FormActions'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { useMemberInvitationAction, type MemberRosterScope } from '../../../facades/users/member-roster'
import { memberDisplayName } from '../../../lib/member-display-name'
import { useToasts } from '../../../providers/ToastProvider'
import { invitationCancelledToast, invitationResentToast } from './member-roster-feedback'

/** The pending invitation's actions share its exact team target at either scope. */
export const MemberInvitationDetailsDialog = ({ invitation, canManage, onClose, scope }: {
  invitation: TeamInvitationRecord | null
  canManage: boolean
  onClose: () => void
  scope: MemberRosterScope
}) => {
  const mutation = useMemberInvitationAction(scope)
  const { pushToast } = useToasts()
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  useEffect(() => {
    setError(null)
    setConfirmCancel(false)
  }, [invitation?.inviteId])

  const name = memberDisplayName(invitation?.name, invitation?.email) ?? 'this person'
  // An invitation is identified by where it was sent, so the confirmation
  // names the address a person can check against their own records.
  const recipient = invitation?.email ?? name

  const act = async (action: 'resend' | 'revoke') => {
    if (!invitation || !canManage) return
    if (scope === 'organization' && !invitation.team?.id) {
      setError('We can’t tell which team this invitation is for. Refresh the page and try again.')
      return
    }
    setError(null)
    try {
      await mutation.mutateAsync({
        action,
        inviteId: invitation.inviteId,
        ...(scope === 'organization' ? { teamId: invitation.team?.id } : {}),
      })
      pushToast(action === 'resend'
        ? invitationResentToast(recipient)
        : invitationCancelledToast(recipient))
      onClose()
    } catch (caught) {
      setError(formErrorMessage(caught, 'Couldn’t update this invitation. Try again.'))
    }
  }

  const awaitingApproval = invitation?.approvalStatus === 'pending'
  const pendingAction = mutation.isPending ? mutation.variables?.action : undefined
  const teamName = invitation?.team?.name
  return (
    <Dialog dismissDisabled={mutation.isPending} onClose={onClose} open={invitation !== null}
      title={confirmCancel ? 'Cancel invitation?' : 'Pending invitation'}>
      <div className="grid gap-5">
        <div>
          <p className="text-[color:var(--tx)]">
            {confirmCancel
              ? `${name} won’t be able to use it to join ${teamName ?? 'the team'}.`
              : name}
          </p>
          {!confirmCancel && invitation?.email ? (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">{invitation.email}</p>
          ) : null}
          {confirmCancel ? (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              You can invite them again later.
            </p>
          ) : null}
          {awaitingApproval ? (
            <p className="mt-2 text-sm text-[color:var(--tx3)]">
              Waiting for an organisation admin to approve it.
            </p>
          ) : null}
        </div>
        <FormError>{error}</FormError>
        <div className="grid grid-cols-2 gap-2">
          <button
            className={`admin-button admin-button-secondary ${canManage && !awaitingApproval && !confirmCancel ? '' : 'col-span-2'}`}
            disabled={mutation.isPending}
            onClick={confirmCancel ? () => setConfirmCancel(false) : onClose}
            type="button"
          >
            {confirmCancel ? 'Keep invitation' : 'Close'}
          </button>
          {canManage && !awaitingApproval ? (
            <>
              {!confirmCancel ? (
                <button
                  className="admin-button admin-button-secondary"
                  disabled={mutation.isPending}
                  onClick={() => void act('resend')}
                  type="button"
                >
                  {pendingAction === 'resend' ? 'Sending…' : 'Resend'}
                </button>
              ) : null}
              <button
                className="admin-button admin-button-secondary admin-button-danger col-span-2"
                disabled={mutation.isPending}
                onClick={() => confirmCancel ? void act('revoke') : setConfirmCancel(true)}
                type="button"
              >
                {pendingAction === 'revoke' ? 'Cancelling…' : 'Cancel invitation'}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
