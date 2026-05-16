import type { ToolRegistryEntryStatus } from '@nessie/schemas'

/**
 * `ToolPermissionPill` reports the lifecycle status of a tool registry entry:
 * `active` means agents may call it, `pending_review` means an admin has to
 * sign off (per plan D9 every emitted row starts pending), and `disabled`
 * means the tool exists but is hard-blocked.
 *
 * Per §8 of provider-system-and-frontend-architecture.md.
 */
type ToolPermissionPillProps = {
  status: ToolRegistryEntryStatus
}

const STATUS_STYLES: Record<ToolRegistryEntryStatus, string> = {
  active: [
    'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  ].join(' '),
  pending_review: [
    'border-amber-400/30 bg-amber-400/10 text-amber-300',
  ].join(' '),
  disabled: [
    'border-rose-400/30 bg-rose-400/10 text-rose-300',
  ].join(' '),
}

const STATUS_LABELS: Record<ToolRegistryEntryStatus, string> = {
  active: 'active',
  pending_review: 'pending review',
  disabled: 'disabled',
}

export const ToolPermissionPill = ({ status }: ToolPermissionPillProps) => (
  <span
    className={[
      'inline-flex rounded-full border px-3 py-1 text-[11px] uppercase',
      'tracking-[0.18em]',
      STATUS_STYLES[status],
    ].join(' ')}
  >
    {STATUS_LABELS[status]}
  </span>
)
