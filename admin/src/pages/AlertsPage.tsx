import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertRow } from '../components/shared/AlertRow'
import {
  getAlertLink,
  useAlerts,
  useMarkAlertsRead,
  type UserAlertRecord,
} from '../facades/alerts/hooks'
import { MobileMenuButton } from '../layouts/admin-shell/MobileMenuButton'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const AlertsPage = () => {
  const navigate = useNavigate()
  const [unreadOnly, setUnreadOnly] = useState(false)
  // apiClient unwraps the { data, meta } envelope and drops meta, so cursor
  // pagination isn't reachable through it — fetch a generous window instead.
  const { data } = useAlerts({ limit: 100, unreadOnly })
  const markRead = useMarkAlertsRead()

  const alerts = data?.alerts ?? []
  const unreadCount = data?.unreadCount ?? 0

  const openAlert = (alert: UserAlertRecord) => {
    if (!alert.readAt) {
      markRead.mutate({ ids: [alert.id] })
    }
    const link = getAlertLink(alert)
    if (link) {
      navigate(link.to, { state: link.state })
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-2 border-b border-[color:var(--sep)] px-5">
        <MobileMenuButton />
        <div className={sectionTitle}>Alerts</div>
        {unreadCount > 0 ? (
          <span className="rounded-full bg-[color:var(--accent-soft)] px-2 py-0.5 text-xs font-semibold text-[color:var(--accent)]">
            {unreadCount} unread
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            onClick={() => setUnreadOnly((value) => !value)}
            type="button"
          >
            {unreadOnly ? 'Show all' : 'Unread only'}
          </button>
          <button
            className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
            disabled={unreadCount === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
            type="button"
          >
            Mark all read
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-2">
          {alerts.map((alert) => (
            <button
              className="admin-card flex w-full items-center gap-2 p-3 text-left"
              key={alert.id}
              onClick={() => openAlert(alert)}
              type="button"
            >
              <AlertRow alert={alert} />
            </button>
          ))}
          {alerts.length === 0 ? (
            <div className="py-8 text-center text-[color:var(--tx3)]">
              {unreadOnly ? 'No unread alerts' : 'No alerts yet'}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
