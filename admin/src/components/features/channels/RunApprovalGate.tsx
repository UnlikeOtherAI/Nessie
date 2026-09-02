import { z } from 'zod'
import { useState } from 'react'

import {
  useApprovalRequest,
  useResolveApproval,
} from '../../../facades/approvals/hooks'
import { useToasts } from '../../../providers/ToastProvider'
import { TabBar } from '../../primitives/TabBar'
import { Dialog } from '../../shared/Dialog'

const ApprovalGateSchema = z.object({
  approvalId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  toolName: z.string().min(1),
})

type Resolution = 'approved' | 'rejected'

const resolutionCopy: Record<Resolution, { action: string; title: string }> = {
  approved: { action: 'Approve action', title: 'Approve this action?' },
  rejected: { action: 'Reject action', title: 'Reject this action?' },
}

const readApprovalGate = (
  metadata: Record<string, unknown> | undefined,
): z.infer<typeof ApprovalGateSchema> | null => {
  const parsed = ApprovalGateSchema.safeParse(metadata?.approvalGate)
  return parsed.success ? parsed.data : null
}

/**
 * The in-thread doorway for a suspended tool gate. Approval data is never
 * copied into message metadata: this resolves the opaque id through the same
 * entitlement-scoped facade as the owning /approvals surface.
 */
export const RunApprovalGate = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const gate = readApprovalGate(metadata)
  const approval = useApprovalRequest(gate?.approvalId)
  const resolve = useResolveApproval()
  const { pushToast } = useToasts()
  const [resolution, setResolution] = useState<Resolution>('approved')
  const [confirmOpen, setConfirmOpen] = useState(false)

  if (!gate) return null

  const active = gate.status === 'pending' && approval.data?.status === 'pending'
  const copy = resolutionCopy[resolution]
  const reason = approval.data?.reason

  const submit = () => {
    resolve.mutate(
      { id: gate.approvalId, resolution },
      {
        onError: (error) => {
          pushToast({ body: error.message, title: 'Could not resolve approval' })
        },
        onSuccess: () => {
          setConfirmOpen(false)
          pushToast({
            body: resolution === 'approved' ? 'The agent can continue.' : 'The proposed action was rejected.',
            title: resolution === 'approved' ? 'Action approved' : 'Action rejected',
          })
        },
      },
    )
  }

  return (
    <section
      className="mt-2 max-w-2xl rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-soft)] p-3"
      data-testid="run-approval-gate"
    >
      <p className="text-sm font-semibold text-[color:var(--tx)]">Approval needed</p>
      <p className="mt-1 text-sm leading-5 text-[color:var(--tx2)]">
        {reason ?? `The agent is waiting before it can run ${gate.toolName}.`}
      </p>
      {approval.isError ? (
        <p className="mt-2 text-xs text-[color:var(--tx3)]">Approval details are no longer available.</p>
      ) : null}
      {active ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
              'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold',
              resolution === 'approved'
                ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                : 'border border-[var(--danger-border)] bg-[var(--panel)] text-[var(--danger-text)]',
            ].join(' ')}
            data-testid="run-approval-gate-open-confirm"
            onClick={() => setConfirmOpen(true)}
            type="button"
          >
            {copy.action}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs font-semibold text-[color:var(--tx3)]">
          {approval.data?.status ?? gate.status}
        </p>
      )}
      <Dialog
        description={reason ?? `Decide whether ${gate.toolName} may run.`}
        dismissDisabled={resolve.isPending}
        onClose={() => setConfirmOpen(false)}
        open={confirmOpen}
        title={copy.title}
      >
        <div className="text-sm text-[color:var(--tx2)]">
          {resolution === 'approved'
            ? 'This lets the agent resume and retry the exact proposed action.'
            : 'This ends the waiting run; the agent will not run this action.'}
        </div>
        <div className="flex justify-end gap-2 pt-5">
          <button
            className="admin-button admin-button-secondary"
            disabled={resolve.isPending}
            onClick={() => setConfirmOpen(false)}
            type="button"
          >
            Cancel
          </button>
          <button
            className={['admin-button', resolution === 'approved' ? 'admin-button-primary' : 'admin-button-danger'].join(' ')}
            disabled={resolve.isPending}
            onClick={submit}
            type="button"
          >
            {resolve.isPending ? 'Resolving…' : copy.action}
          </button>
        </div>
      </Dialog>
    </section>
  )
}
