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
export const AlertRow = ({ alert }: { alert: UserAlertRecord }) => {
  const unread = alert.readAt === null
  const actor = alert.actorDisplayName ?? 'Someone'
  const description = alert.kind === 'trigger_health'
    // No actor: nobody did this, a schedule stopped being able to run.
    ? 'A scheduled task stopped running'
    : alert.kind === 'task_assigned'
      ? `${actor} assigned work to you`
      : alert.kind === 'knowledge_published'
        ? `${actor} published knowledge for you`
        : alert.kind === 'call_missed'
          ? `Missed call from ${actor}${alert.channelLabel ? ` in ${alert.channelLabel}` : ''}`
        : `${actor} mentioned you${alert.channelLabel ? ` in ${alert.channelLabel}` : ''}`

  return (
    <>
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
    </>
  )
}
