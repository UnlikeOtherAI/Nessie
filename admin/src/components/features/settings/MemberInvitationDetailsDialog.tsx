import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('settings')
  const mutation = useMemberInvitationAction(scope)
  const { pushToast } = useToasts()
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  useEffect(() => {
    setError(null)
    setConfirmCancel(false)
  }, [invitation?.inviteId])

  const name = memberDisplayName(invitation?.name, invitation?.email) ?? t('members.invitationDetails.thisPerson')
  // An invitation is identified by where it was sent, so the confirmation
  // names the address a person can check against their own records.
  const recipient = invitation?.email ?? name

  const act = async (action: 'resend' | 'revoke') => {
    if (!invitation || !canManage) return
    if (scope === 'organization' && !invitation.team?.id) {
      setError(t('members.invitationDetails.teamUnknown'))
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
        ? invitationResentToast(recipient, t)
        : invitationCancelledToast(recipient, t))
      onClose()
    } catch (caught) {
      setError(formErrorMessage(caught, t('members.invitationDetails.updateFailed')))
    }
  }

  const awaitingApproval = invitation?.approvalStatus === 'pending'
  const pendingAction = mutation.isPending ? mutation.variables?.action : undefined
  const teamName = invitation?.team?.name
  return (
    <Dialog dismissDisabled={mutation.isPending} onClose={onClose} open={invitation !== null}
      title={t(confirmCancel ? 'members.invitationDetails.cancelTitle' : 'members.invitationDetails.title')}>
      <div className="grid gap-5">
        <div>
          <p className="text-[color:var(--tx)]">
            {confirmCancel
              ? t('members.invitationDetails.cancelBody', { name, team: teamName ?? t('team.team') })
              : name}
          </p>
          {!confirmCancel && invitation?.email ? (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">{invitation.email}</p>
          ) : null}
          {confirmCancel ? (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {t('members.invitationDetails.inviteAgain')}
            </p>
          ) : null}
          {awaitingApproval ? (
            <p className="mt-2 text-sm text-[color:var(--tx3)]">
              {t('members.invitationDetails.awaitingApproval')}
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
            {t(confirmCancel ? 'members.invitationDetails.keep' : 'common.cancel')}
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
                  {t(pendingAction === 'resend' ? 'members.invitationDetails.sending' : 'members.invitationDetails.resend')}
                </button>
              ) : null}
              <button
                className="admin-button admin-button-secondary admin-button-danger col-span-2"
                disabled={mutation.isPending}
                onClick={() => confirmCancel ? void act('revoke') : setConfirmCancel(true)}
                type="button"
              >
                {t(pendingAction === 'revoke' ? 'members.invitationDetails.cancelling' : 'members.invitationDetails.cancel')}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
