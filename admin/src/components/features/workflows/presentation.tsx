import type {
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowStepRunRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import type { PillTone } from '../../primitives/Pill'

export const formatTimestamp = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—'

export const formatRelativeTime = (value?: string | null): string | undefined => {
  if (!value) return undefined

  const target = new Date(value).getTime()
  if (Number.isNaN(target)) return undefined

  const deltaMs = target - Date.now()
  const absMinutes = Math.round(Math.abs(deltaMs) / 60_000)
  if (absMinutes < 1) return deltaMs >= 0 ? 'in <1 min' : 'just now'

  const suffix = deltaMs >= 0 ? 'in ' : ''
  const prefix = deltaMs >= 0 ? '' : ' ago'
  if (absMinutes < 60) return `${suffix}${absMinutes} min${prefix}`

  const absHours = Math.round(absMinutes / 60)
  if (absHours < 48) return `${suffix}${absHours} h${prefix}`

  return `${suffix}${Math.round(absHours / 24)} d${prefix}`
}

export const formatDuration = (
  start?: string | null,
  end?: string | null,
): string | undefined => {
  if (!start || !end) return undefined

  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`
  return `${Math.round(ms / 60_000)} min`
}

/**
 * One status→{tone, dot-colour} mapping, built once from `Pill`'s own tone
 * system, rather than a second `Record<Status, string>` beside every tone
 * getter below. `getRunTone`/`getInstallationTone`/`getStepTone` stay the
 * single source of what a status *means*; a dot is just that tone rendered
 * small, in a list row dense enough that a full `Pill` would not fit.
 */
const TONE_DOT_COLOR: Record<PillTone, string> = {
  accent: 'var(--thinking)',
  danger: 'var(--danger-text)',
  info: 'var(--info-text)',
  muted: 'var(--tx3)',
  outline: 'var(--tx2)',
  success: 'var(--success-text)',
  warning: 'var(--warning-text)',
}

export const getStepTone = (status: WorkflowStepRunRecord['status']): PillTone => {
  switch (status) {
    case 'running':
      return 'success'
    case 'pending':
      return 'warning'
    case 'completed':
      return 'info'
    case 'failed':
      return 'danger'
    case 'blocked':
      return 'warning'
    default:
      return 'muted'
  }
}

/** Status as a colour token for compact list dots. */
export const getRunStatusColor = (status: WorkflowRunRecord['status']): string =>
  TONE_DOT_COLOR[getRunTone(status)]

export const getStepStatusColor = (status: WorkflowStepRunRecord['status']): string =>
  TONE_DOT_COLOR[getStepTone(status)]

const formatJsonValue = (value: unknown) => {
  if (value === undefined) {
    return 'undefined'
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export const JsonBlock = ({
  label,
  value,
}: {
  label: string
  value: unknown
}) => (
  <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-3">
    <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
      {label}
    </div>
    <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-[var(--tx)]">
      {formatJsonValue(value)}
    </pre>
  </div>
)

export const getWorkflowTemplateLabel = (
  template: WorkflowTemplateRecord | undefined,
  installation: WorkflowInstallationRecord,
) => template?.name ?? installation.workflowTemplateId.slice(0, 8)

export const getInstallationTone = (
  status: WorkflowInstallationRecord['status'],
) => {
  switch (status) {
    case 'active':
      return 'success' as const
    case 'paused':
      return 'warning' as const
    case 'disabled':
      return 'danger' as const
    case 'draft':
      return 'muted' as const
    default:
      return 'muted' as const
  }
}

export const getRunTone = (status: WorkflowRunRecord['status']) => {
  switch (status) {
    case 'running':
      return 'success' as const
    case 'pending':
      return 'warning' as const
    case 'completed':
      return 'accent' as const
    case 'failed':
      return 'danger' as const
    case 'cancelled':
      return 'muted' as const
    default:
      return 'muted' as const
  }
}

export const isActiveRun = (status: WorkflowRunRecord['status']): boolean =>
  status === 'pending' || status === 'running'

export const isTerminalRun = (status: WorkflowRunRecord['status']): boolean =>
  status === 'cancelled' || status === 'completed' || status === 'failed'
