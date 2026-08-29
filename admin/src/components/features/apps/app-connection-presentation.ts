import type { AppConnectionStatus, AppConnectionSummaryRecord } from '@nessie/schemas'

/**
 * A connected account, said in words a person recognises.
 *
 * "Install scope" is the internal model; what somebody actually wants to know
 * is who else this account works for. "Instance", "credential", "transport" and
 * "token" appear nowhere.
 *
 * Who an account works for is `AppConnectionSummaryRecord.displayName`, worded
 * once by the server (`@nessie/mcp-manage` `presentAppConnection`). A second
 * map here drifted from it word for word — "Just me" above "Just you", and a
 * system install reading "Everyone on this instance" above "Managed by
 * Nessie" — so the row now renders the server's name and nothing restates it.
 */

export type ConnectionStatusPill = {
  label: string
  tone: 'accent' | 'danger' | 'muted' | 'success' | 'warning'
}

/**
 * Outcome, not mechanism: a person reading "Needs reconnect" knows what to do,
 * where "token expired" only tells them what broke.
 */
const STATUS_PILLS: Record<AppConnectionStatus, ConnectionStatusPill> = {
  connecting: { label: 'Connecting', tone: 'accent' },
  connected: { label: 'Connected', tone: 'success' },
  expired: { label: 'Needs reconnect', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
  disabled: { label: 'Turned off', tone: 'muted' },
}

export const connectionStatusPill = (status: AppConnectionStatus): ConnectionStatusPill =>
  STATUS_PILLS[status]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long this account has been working, at the resolution that matters. An
 * exact timestamp answers no question a member has; "3 days ago" answers "is
 * this still live?".
 */
export const connectionConnectedLabel = (
  connection: Pick<AppConnectionSummaryRecord, 'lastConnectedAt'>,
  now: number,
): string | null => {
  if (!connection.lastConnectedAt) return null
  const at = Date.parse(connection.lastConnectedAt)
  if (Number.isNaN(at)) return null

  const elapsed = Math.max(0, now - at)
  if (elapsed < MINUTE) return 'Connected just now'
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE)
    return `Connected ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    return `Connected ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  const days = Math.floor(elapsed / DAY)
  if (days < 30) return `Connected ${days} ${days === 1 ? 'day' : 'days'} ago`
  return `Connected on ${connection.lastConnectedAt.slice(0, 10)}`
}
