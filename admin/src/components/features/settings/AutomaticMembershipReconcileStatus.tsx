/**
 * Reconciliation progress: counters, never a list of people.
 *
 * An administrator needs to know how far a run has got and whether anything is
 * failing. They do not need — and must not be handed — a roster of everyone in
 * the organisation whose address happens to match a domain, so this renders
 * aggregate numbers only.
 *
 * Counters live in `role="status"` with `aria-live="polite"`: they update while
 * a run walks, and a polite region is the right register for progress. An
 * alert region would interrupt on every tick.
 */

import type { AutomaticMembershipReconcileRecord } from '@nessie/schemas'

import { Notice } from '../../primitives/Notice'
import { Pill, type PillTone } from '../../primitives/Pill'

type Props = {
  run: AutomaticMembershipReconcileRecord
  canManage: boolean
  pending: boolean
  onCancel: () => void
  onRerun: () => void
}

const STATUS_LABEL: Record<AutomaticMembershipReconcileRecord['status'], string> = {
  cancelled: 'Stopped',
  completed: 'Finished',
  failed: 'Stopped early',
  queued: 'Starting',
  running: 'Adding people',
  superseded: 'Replaced by a newer run',
}

const STATUS_TONE: Record<AutomaticMembershipReconcileRecord['status'], PillTone> = {
  cancelled: 'muted',
  completed: 'success',
  failed: 'danger',
  queued: 'info',
  running: 'info',
  superseded: 'muted',
}

const isActive = (status: AutomaticMembershipReconcileRecord['status']): boolean =>
  status === 'queued' || status === 'running'

export const AutomaticMembershipReconcileStatus = ({
  canManage,
  onCancel,
  onRerun,
  pending,
  run,
}: Props) => (
  <div className="grid gap-2 border-t border-[color:var(--border)] pt-3">
    <div className="flex flex-wrap items-center gap-2">
      <Pill radius="chip" size="sm" tone={STATUS_TONE[run.status]} uppercase={false}>
        {STATUS_LABEL[run.status]}
      </Pill>
      <p aria-live="polite" className="text-xs text-[color:var(--tx2)]" role="status">
        {`${run.scanned} checked · ${run.matched} matched · ${run.granted} added · `
          + `${run.skipped} already had access${run.failed > 0 ? ` · ${run.failed} failed` : ''}`}
      </p>
    </div>
    {run.lastError ? (
      <Notice role="status" size="sm" tone="warning">{run.lastError}</Notice>
    ) : null}
    {canManage ? (
      <div className="flex flex-wrap gap-2">
        {isActive(run.status) ? (
          <button
            className="admin-button admin-button-secondary admin-button-sm"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            Stop adding
          </button>
        ) : (
          <button
            className="admin-button admin-button-secondary admin-button-sm"
            disabled={pending}
            onClick={onRerun}
            type="button"
          >
            Run again
          </button>
        )}
      </div>
    ) : null}
  </div>
)
