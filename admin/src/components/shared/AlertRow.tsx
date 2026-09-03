import type { UserAlertRecord } from '../../facades/alerts/hooks'

const formatRelativeTime = (value: string): string => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return ''
  }

  const deltaMs = Date.now() - timestamp
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }
  return new Date(timestamp).toLocaleDateString()
}

// Shared inner content of one alert row (unread dot, mention text, relative
// timestamp). The wrapping container differs per surface: the top-bar bell
// uses .admin-topbar-menu-item, the /alerts page an admin-card row.
type AlertRowProps = {
  acceptError?: string | null
  accepting?: boolean
  alert: UserAlertRecord
  className?: string
  onAcceptInvitation?: () => void
  onOpen?: () => void
}

const describeAlert = (alert: UserAlertRecord): string => {
  const actor = alert.actorDisplayName ?? 'Someone'
  if (alert.kind === 'team_invitation') {
    if (!alert.metadata) return 'Team invitation'
    return alert.metadata.invitedBy
      ? `${alert.metadata.invitedBy} invited you to ${alert.metadata.teamName}`
      : alert.metadata.teamName
  }
  if (alert.kind === 'trigger_health') {
    // No actor: nobody did this, a schedule stopped being able to run.
    return 'A scheduled task stopped running'
  }
  if (alert.kind === 'approval_requested') {
    // Deliberately generic: the alert body reaches a lock screen, and what is
    // waiting for approval is exactly the thing that must not travel there.
    return `${actor} needs your approval`
  }
  if (alert.kind === 'task_assigned') return `${actor} assigned work to you`
  if (alert.kind === 'knowledge_published') return `${actor} published knowledge for you`
  if (alert.kind === 'call_missed') {
    return `Missed call from ${actor}${alert.channelLabel ? ` in ${alert.channelLabel}` : ''}`
  }
  return `${actor} mentioned you${alert.channelLabel ? ` in ${alert.channelLabel}` : ''}`
}

export const AlertRow = ({
  acceptError,
  accepting = false,
  alert,
  className,
  onAcceptInvitation,
  onOpen,
}: AlertRowProps) => {
  const unread = alert.readAt === null
  const invite = alert.kind === 'team_invitation' ? alert.metadata : null
  const description = describeAlert(alert)

  return (
    <div className={['flex w-full flex-wrap items-center gap-2', className ?? ''].join(' ')}>
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onOpen}
        type="button"
      >
        <span
          aria-hidden="true"
          className={[
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            unread ? 'bg-[color:var(--accent)]' : '',
          ].join(' ')}
        />
        <span
          className={[
            'min-w-0 flex-1',
            unread ? 'font-semibold text-[color:var(--tx)]' : 'text-[color:var(--tx2)]',
          ].join(' ')}
        >
          {description}
        </span>
        <span className="shrink-0 text-xs font-normal text-[color:var(--tx3)]">
          {formatRelativeTime(alert.createdAt)}
        </span>
      </button>
      {invite && onAcceptInvitation ? (
        <button
          className="rounded-md bg-[color:var(--accent)] px-2 py-1 text-xs font-semibold text-[color:var(--on-accent)] disabled:opacity-60"
          disabled={accepting}
          onClick={onAcceptInvitation}
          type="button"
        >
          {accepting ? 'Accepting…' : 'Accept'}
        </button>
      ) : null}
      {acceptError ? (
        <span className="w-full text-xs text-[color:var(--danger-text)]" role="alert">
          {acceptError}
        </span>
      ) : null}
    </div>
  )
}
