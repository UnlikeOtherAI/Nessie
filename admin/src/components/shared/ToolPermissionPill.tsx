import type { ToolRegistryEntryStatus } from '@nessie/schemas'
import { Pill, type PillTone } from '../primitives/Pill'

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

const STATUS_TONES: Record<ToolRegistryEntryStatus, PillTone> = {
  active: 'success',
  pending_review: 'warning',
  disabled: 'danger',
}

// The border is tinted with the status colour rather than `bordered`'s neutral
// `--sep`: on a dense permissions table the outline is what separates the three
// states when the soft fills read as near-identical washes.
const STATUS_BORDERS: Record<ToolRegistryEntryStatus, string> = {
  active: 'border border-[color:var(--success-border)]',
  pending_review: 'border border-[color:var(--warning-border)]',
  disabled: 'border border-[color:var(--danger-border)]',
}

const STATUS_LABELS: Record<ToolRegistryEntryStatus, string> = {
  active: 'active',
  pending_review: 'pending review',
  disabled: 'disabled',
}

export const ToolPermissionPill = ({ status }: ToolPermissionPillProps) => (
  <Pill className={STATUS_BORDERS[status]} tone={STATUS_TONES[status]}>
    {STATUS_LABELS[status]}
  </Pill>
)
