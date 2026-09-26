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
import { useTranslation } from 'react-i18next'

import { Notice } from '../../primitives/Notice'
import { Pill, type PillTone } from '../../primitives/Pill'

type Props = {
  run: AutomaticMembershipReconcileRecord
  canManage: boolean
  pending: boolean
  onCancel: () => void
  onRerun: () => void
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
}: Props) => {
  const { t } = useTranslation('settings')
  return (
  <div className="grid gap-2 border-t border-[color:var(--border)] pt-3">
    <div className="flex flex-wrap items-center gap-2">
      <Pill radius="chip" size="sm" tone={STATUS_TONE[run.status]} uppercase={false}>
        {t(`automaticMembership.runStatuses.${run.status}`)}
      </Pill>
      <p aria-live="polite" className="text-xs text-[color:var(--tx2)]" role="status">
        {t('automaticMembership.runSummary', { scanned: run.scanned, matched: run.matched, granted: run.granted, skipped: run.skipped, failed: run.failed })}
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
            {t('automaticMembership.stopAdding')}
          </button>
        ) : (
          <button
            className="admin-button admin-button-secondary admin-button-sm"
            disabled={pending}
            onClick={onRerun}
            type="button"
          >
            {t('automaticMembership.runAgain')}
          </button>
        )}
      </div>
    ) : null}
  </div>
  )
}
