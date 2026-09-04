import { z } from 'zod'
import { useState } from 'react'

import {
  useApprovalRequest,
  useMailboxSendApprovalDraft,
  useResolveApproval,
} from '../../../facades/approvals/hooks'
import {
  useGrantFromApproval,
  type ApprovalDuration,
} from '../../../facades/approvals/gate-hooks'
import { useToasts } from '../../../providers/ToastProvider'
import { TabBar } from '../../primitives/TabBar'
import { Dialog } from '../../shared/Dialog'
import { MailboxSendApprovalPreview } from './MailboxSendApprovalPreview'

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

const DURATIONS: { value: ApprovalDuration; label: string }[] = [
  { value: 'today', label: 'for today' },
  { value: '30d', label: 'for 30 days' },
  { value: 'forever', label: 'until I turn it off' },
]

const readString = (
  context: Record<string, unknown> | null | undefined,
  key: string,
): string | null => {
  const value = context?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The in-thread doorway for a suspended tool gate. Approval data is never
 * copied into message metadata: this resolves the opaque id through the same
 * entitlement-scoped facade as the owning /approvals surface.
 *
 * The card answers three questions in order — what will happen, who finds out,
 * and how to stop being asked. The audience line is the point: it is the actual
 * thing being approved. Exact arguments sit behind a disclosure, because they
 * are what a person checks when something looks wrong rather than what they
 * decide on. Mail sends are the exception: their pinned approver sees the full
 * frozen draft before approval, because a truncated argument summary cannot
 * provide informed consent for blind copies or the body.
 */
export const RunApprovalGate = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const gate = readApprovalGate(metadata)
  const approval = useApprovalRequest(gate?.approvalId)
  const isMailboxSend = gate?.toolName === 'mailbox_send'
  const mailboxDraft = useMailboxSendApprovalDraft(
    isMailboxSend ? gate?.approvalId : undefined,
  )
  const resolve = useResolveApproval()
  const { pushToast } = useToasts()
  const grant = useGrantFromApproval()
  // Deliberately NOT a `useTabParam` host (docs/navigation/overview.md §1, "Tab
  // hosts"): this strip is a field of the card's form, not a section of a
  // screen. A feed renders one gate per pending approval, so a single URL param
  // could not hold the answers apart; and the answer is submitted and thrown
  // away, so putting it in the URL would outlive the approval it decided.
  const [resolution, setResolution] = useState<Resolution>('approved')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [duration, setDuration] = useState<ApprovalDuration>('30d')
  const [showDetails, setShowDetails] = useState(false)

  if (!gate) return null

  const active = gate.status === 'pending' && approval.data?.status === 'pending'
  const copy = resolutionCopy[resolution]
  const context = approval.data?.context ?? null
  // Server-authored: a plain-language description beats the tool id, and the
  // audience line is what the person is really being asked about.
  const headline = readString(context, 'headline')
  const audience = readString(context, 'audience')
  const details = isMailboxSend ? null : readString(context, 'inputSummary')
  const boundaryReason = readString(context, 'boundaryReason')
  const reason = approval.data?.reason
  const isCalendar = gate.toolName.startsWith('calendar_')
  const canApprove = !isMailboxSend || Boolean(mailboxDraft.data)

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
      <p className="text-[11px] font-semibold uppercase text-[color:var(--tx3)]">
        Needs your approval
      </p>
      <p className="mt-1 text-sm font-semibold text-[color:var(--tx)]">
        {headline ?? reason ?? `The agent is waiting before it can run ${gate.toolName}.`}
      </p>
      {audience ? (
        <p className="mt-1 text-sm font-semibold leading-5 text-[color:var(--tx2)]">
          {audience}
        </p>
      ) : null}
      {boundaryReason ? (
        <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
          Your assistant wasn’t sure this fits your note, so it’s asking. {boundaryReason}
        </p>
      ) : null}
      {details ? (
        <div className="mt-2">
          <button
            className="text-[11px] font-semibold text-[color:var(--tx3)]"
            data-testid="run-approval-gate-details"
            onClick={() => setShowDetails((value) => !value)}
            type="button"
          >
            {showDetails ? '⌄ Hide the details' : '› Show the details'}
          </button>
          {showDetails ? (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-2 text-[11px] leading-4 text-[color:var(--tx2)]">
              {details}
            </pre>
          ) : null}
        </div>
      ) : null}
      {isMailboxSend && mailboxDraft.data ? (
        <MailboxSendApprovalPreview draft={mailboxDraft.data} />
      ) : null}
      {isMailboxSend && mailboxDraft.isLoading ? (
        <p className="mt-2 text-xs text-[color:var(--tx3)]">Loading the full email to send…</p>
      ) : null}
      {isMailboxSend && mailboxDraft.isError ? (
        <p className="mt-2 text-xs text-[color:var(--danger-text)]">
          The complete email can no longer be read. It cannot be approved.
        </p>
      ) : null}
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
            disabled={resolve.isPending || (resolution === 'approved' && !canApprove)}
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
      {/* Stopping the asking belongs here, not on a separate settings trip:
          somebody who wants their assistant running their diary should not
          confirm every entry. It never applies to a schedule or an automation. */}
      {active && !isMailboxSend ? (
        <div className="mt-3 border-t border-[color:var(--warning-border)] pt-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--tx3)]">
            <span>
              {isCalendar ? 'Stop asking about my calendar' : 'Stop asking me'}
            </span>
            <select
              aria-label="How long to stop asking"
              className="rounded border border-[color:var(--sep)] bg-[color:var(--panel)] px-1.5 py-0.5 text-[11px] text-[color:var(--tx)]"
              disabled={grant.isPending || resolve.isPending}
              onChange={(event) =>
                setDuration(event.target.value as ApprovalDuration)
              }
              value={duration}
            >
              {DURATIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
            <button
              className="admin-button admin-button-secondary"
              data-testid="run-approval-gate-always"
              disabled={grant.isPending || resolve.isPending}
              onClick={() => {
                grant.mutate(
                  { approvalId: gate.approvalId, duration, mode: 'always' },
                  {
                    onError: (error) =>
                      pushToast({
                        body: error.message,
                        title: 'Could not save that rule',
                      }),
                    onSuccess: () => {
                      resolve.mutate(
                        { id: gate.approvalId, resolution: 'approved' },
                        {
                          onSuccess: () =>
                            pushToast({
                              body: 'You can take it back in Connected accounts.',
                              title: 'Approved — and I won’t ask again',
                            }),
                        },
                      )
                    },
                  },
                )
              }}
              type="button"
            >
              Approve, and don’t ask again
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-[color:var(--tx3)]">
            {isCalendar
              ? 'Adds a rule to Connected accounts: this agent may manage your calendar without confirming.'
              : 'Adds a rule to Connected accounts: this agent may act on this account without confirming.'}{' '}
            It never applies to a schedule or an automation.
          </p>
        </div>
      ) : null}
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
            disabled={resolve.isPending || (resolution === 'approved' && !canApprove)}
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
