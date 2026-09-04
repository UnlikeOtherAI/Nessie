import { useState } from 'react'

import { useResolveApproval } from '../../../facades/approvals/hooks'
import { useToasts } from '../../../providers/ToastProvider'
import { TabBar } from '../../primitives/TabBar'
import { ConfirmDialog } from '../../shared/ConfirmDialog'

type Resolution = 'approved' | 'rejected'

const copy: Record<Resolution, { confirm: string; label: string; title: string }> = {
  approved: {
    confirm: 'Approve',
    label: 'Approve',
    title: 'Approve this action?',
  },
  rejected: {
    confirm: 'Reject',
    label: 'Reject',
    title: 'Reject this action?',
  },
}

/**
 * The single decision control for approval surfaces. It intentionally makes
 * the last click explicit: a pending action is never resolved by the first
 * press of an Approve/Reject affordance. Its strip is a field in an individual
 * decision form, not a screen section: a pending-approval list can render
 * many of these controls and the email review is transient, so a URL tab
 * would neither address nor outlive the right choice.
 */
export const ApprovalDecision = ({
  approvalId,
  blockingConfirmation = false,
  description,
  disabled = false,
  onResolved,
}: {
  approvalId: string
  /** An email review is already a Dialog, so its confirmation blocks above it. */
  blockingConfirmation?: boolean
  description: string
  disabled?: boolean
  onResolved?: () => void
}) => {
  const { pushToast } = useToasts()
  const resolve = useResolveApproval()
  const [resolution, setResolution] = useState<Resolution>('approved')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const action = copy[resolution]

  const submit = () => {
    resolve.mutate(
      { id: approvalId, resolution },
      {
        onError: (error) => {
          pushToast({ body: error.message, title: 'Could not resolve approval' })
        },
        onSuccess: () => {
          setConfirmOpen(false)
          pushToast({
            body: resolution === 'approved'
              ? 'The agent can continue.'
              : 'The proposed action was rejected.',
            title: resolution === 'approved' ? 'Action approved' : 'Action rejected',
          })
          onResolved?.()
        },
      },
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <TabBar<Resolution>
          ariaLabel="Approval decision"
          items={[
            { label: 'Approve', value: 'approved' },
            { label: 'Reject', value: 'rejected' },
          ]}
          onChange={setResolution}
          role="radiogroup"
          size="sm"
          value={resolution}
        />
        <button
          className={[
            'admin-button',
            resolution === 'approved' ? 'admin-button-primary' : 'admin-button-danger',
          ].join(' ')}
          data-testid="approval-decision-open-confirm"
          disabled={disabled || resolve.isPending}
          onClick={() => setConfirmOpen(true)}
          type="button"
        >
          {action.label}
        </button>
      </div>
      <ConfirmDialog
        blocking={blockingConfirmation}
        body={
          resolution === 'approved'
            ? description
            : 'This ends the waiting run; the agent will not take this action.'
        }
        confirmLabel={resolve.isPending ? 'Resolving…' : action.confirm}
        destructive={resolution === 'rejected'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
        open={confirmOpen}
        pending={resolve.isPending}
        title={action.title}
      />
    </>
  )
}
