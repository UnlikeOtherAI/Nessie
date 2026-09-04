import { useQueryClient } from '@tanstack/react-query'

import { ApprovalDecision } from './ApprovalDecision'
import {
  removeEmailApprovalReview,
  useEmailApprovalReview,
  type ApprovalRequest,
} from '../../../facades/approvals/hooks'
import { Dialog } from '../../shared/Dialog'

const recipientLine = (recipients: string[]): string =>
  recipients.length > 0 ? recipients.join(', ') : 'None'

/**
 * A transient, pinned view of the exact email proposal. Its query is disabled
 * until the modal opens and the API answers 404 for every non-approver, so no
 * message detail becomes part of the approval list or its realtime payload.
 */
export const EmailApprovalReviewDialog = ({
  approval,
  onClose,
  open,
}: {
  approval: ApprovalRequest | null
  onClose: () => void
  open: boolean
}) => {
  const queryClient = useQueryClient()
  const review = useEmailApprovalReview(approval?.id, open && approval !== null)
  const detail = review.data
  const close = () => {
    removeEmailApprovalReview(queryClient, approval?.id)
    onClose()
  }

  return (
    <Dialog
      description="Review the exact email before deciding. Only the assigned approver can open it."
      onClose={close}
      open={open}
      size="lg"
      title="Review email"
    >
      {review.isLoading ? (
        <p className="text-sm text-[color:var(--tx3)]">Loading the proposed email…</p>
      ) : review.isError || !detail ? (
        <p className="text-sm text-[color:var(--tx3)]">
          This email is no longer available to review. Ask the agent to propose it again.
        </p>
      ) : (
        <div className="space-y-4">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="font-medium text-[color:var(--tx3)]">From</dt>
            <dd className="min-w-0 break-words text-[color:var(--tx)]">
              {detail.mailboxLabel}
              {detail.senderAddress && detail.senderAddress !== detail.mailboxLabel
                ? ` (${detail.senderAddress})`
                : ''}
            </dd>
            <dt className="font-medium text-[color:var(--tx3)]">To</dt>
            <dd className="min-w-0 break-words text-[color:var(--tx)]">{recipientLine(detail.to)}</dd>
            {detail.cc.length > 0 ? (
              <>
                <dt className="font-medium text-[color:var(--tx3)]">Cc</dt>
                <dd className="min-w-0 break-words text-[color:var(--tx)]">{recipientLine(detail.cc)}</dd>
              </>
            ) : null}
            {detail.bcc.length > 0 ? (
              <>
                <dt className="font-medium text-[color:var(--tx3)]">Bcc</dt>
                <dd className="min-w-0 break-words text-[color:var(--tx)]">{recipientLine(detail.bcc)}</dd>
              </>
            ) : null}
            <dt className="font-medium text-[color:var(--tx3)]">Subject</dt>
            <dd className="min-w-0 break-words text-[color:var(--tx)]">{detail.subject || '(No subject)'}</dd>
            {detail.attachments.length > 0 ? (
              <>
                <dt className="font-medium text-[color:var(--tx3)]">Attachments</dt>
                <dd className="min-w-0 break-words text-[color:var(--tx)]">
                  {detail.attachments.map((attachment) => attachment.filename).join(', ')}
                </dd>
              </>
            ) : null}
          </dl>

          <div className="border-t border-[color:var(--sep)] pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]">Message</p>
            <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-[color:var(--tx)]">
              {detail.text}
            </p>
          </div>

          <div className="border-t border-[color:var(--sep)] pt-4">
            <ApprovalDecision
              approvalId={detail.approvalId}
              blockingConfirmation
              description="This sends the exact email you just reviewed."
              onResolved={close}
            />
          </div>
        </div>
      )}
    </Dialog>
  )
}
