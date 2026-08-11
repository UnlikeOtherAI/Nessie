import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertRow } from '../components/shared/AlertRow'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import {
  getAlertLink,
  useAlerts,
  useMarkAlertsRead,
  type UserAlertRecord,
} from '../facades/alerts/hooks'

export const AlertsPage = () => {
  const navigate = useNavigate()
  const [unreadOnly, setUnreadOnly] = useState(false)
  // apiClient unwraps the { data, meta } envelope and drops meta, so cursor
  // pagination isn't reachable through it — fetch a generous window instead.
  const { data } = useAlerts({ limit: 100, unreadOnly })
  const markRead = useMarkAlertsRead()

  const alerts = data?.alerts ?? []
  const unreadCount = data?.unreadCount ?? 0
  const headerActions: PageHeaderAction[] = [
    {
      id: 'unread-only',
      label: unreadOnly ? 'Show all' : `Unread only${unreadCount > 0 ? ` (${unreadCount})` : ''}`,
      onSelect: () => setUnreadOnly((value) => !value),
      priority: 80,
      selected: unreadOnly,
    },
    {
      disabled: unreadCount === 0 || markRead.isPending,
      id: 'mark-all-read',
      label: 'Mark all read',
      onSelect: () => markRead.mutate({ all: true }),
      priority: 60,
    },
  ]

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
      <AdminPageHeader actions={headerActions} title="Alerts" />

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
