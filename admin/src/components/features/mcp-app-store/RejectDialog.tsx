import { useState } from 'react'
import type { McpCatalogEntryRecord } from '../../../facades/mcp-catalog/hooks'

/**
 * Captures the required rejection reason when a superuser rejects a public
 * connector submission. The reason is surfaced back to the submitter on the
 * entry so they can revise and resubmit.
 */

type RejectDialogProps = {
  entry: McpCatalogEntryRecord
  pending: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

export const RejectDialog = ({
  entry,
  pending,
  onCancel,
  onConfirm,
}: RejectDialogProps) => {
  const [reason, setReason] = useState('')
  const trimmed = reason.trim()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim-strong)] px-4">
      <div
        className={[
          'admin-card w-full max-w-md rounded-xl border border-[color:var(--sep)]',
          'bg-[color:var(--main)] p-6 text-[color:var(--tx)]',
        ].join(' ')}
      >
        <h2 className="text-lg font-semibold text-[var(--tx)]">
          Reject “{entry.label}”
        </h2>
        <p className="mt-1 text-sm text-[color:var(--tx3)]">
          The connector reverts to a private draft for its author with this
          reason attached.
        </p>
        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
          Reason
          <textarea
            autoFocus
            className={[
              'admin-input mt-1 w-full rounded-md border border-[color:var(--sep)]',
              'bg-[var(--scrim)] px-3 py-2 text-sm text-[var(--tx)]',
              'focus:border-[color:var(--accent)] focus:outline-none',
            ].join(' ')}
            data-testid="reject-reason"
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            value={reason}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className={[
              'admin-button rounded-md border border-[color:var(--sep)]',
              'px-4 py-2 text-sm text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
            ].join(' ')}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className={[
              'admin-button rounded-md border border-[var(--danger-border)]',
              'px-4 py-2 text-sm font-semibold text-[var(--danger-text)] hover:bg-[var(--danger-soft)]',
              'disabled:cursor-not-allowed disabled:opacity-40',
            ].join(' ')}
            data-testid="reject-confirm"
            disabled={pending || trimmed.length === 0}
            onClick={() => onConfirm(trimmed)}
            type="button"
          >
            {pending ? 'Rejecting…' : 'Reject submission'}
          </button>
        </div>
      </div>
    </div>
  )
}
