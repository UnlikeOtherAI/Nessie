import type {
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowStepRunRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'

export const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const pillBase =
  'rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.15em]'
export const dangerPill =
  `${pillBase} bg-[var(--danger-soft)] text-[var(--danger-text)] hover:bg-[var(--danger-soft)] disabled:opacity-40`
export const infoPill =
  `${pillBase} bg-[var(--info-soft)] text-[var(--info-text)] hover:bg-[var(--info-soft)] disabled:opacity-40`
const stepActionPillBase =
  'rounded-full bg-[var(--overlay-weak)] px-3 py-1 text-[11px] font-semibold uppercase'
export const stepActionPill =
  `${stepActionPillBase} tracking-[0.12em] text-[color:var(--tx2)] hover:bg-[var(--overlay)] disabled:opacity-30`

export const formatTimestamp = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : '—'

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

export const runStatusClass = (status: WorkflowRunRecord['status']): string => {
  switch (status) {
    case 'running':
      return 'text-[var(--success-text)]'
    case 'pending':
      return 'text-[var(--warning-text)]'
    case 'completed':
      return 'text-[var(--info-text)]'
    case 'failed':
      return 'text-[var(--danger-text)]'
    case 'cancelled':
      return 'text-[color:var(--tx3)]'
    default:
      return 'text-[var(--tx)]'
  }
}

export const stepStatusClass = (
  status: WorkflowStepRunRecord['status'],
): string => {
  switch (status) {
    case 'running':
      return 'text-[var(--success-text)]'
    case 'pending':
      return 'text-[var(--warning-text)]'
    case 'completed':
      return 'text-[var(--info-text)]'
    case 'failed':
      return 'text-[var(--danger-text)]'
    case 'skipped':
      return 'text-[color:var(--tx3)]'
    case 'blocked':
      return 'text-[var(--warning-text)]'
    default:
      return 'text-[var(--tx)]'
  }
}

export const isActiveRun = (status: WorkflowRunRecord['status']): boolean =>
  status === 'pending' || status === 'running'

export const isTerminalRun = (status: WorkflowRunRecord['status']): boolean =>
  status === 'cancelled' || status === 'completed' || status === 'failed'
