import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertRow } from '../../components/shared/AlertRow'
import { UnreadBadge } from '../../components/primitives/UnreadBadge'
import { useFocusMode } from '../../providers/FocusModeProvider'
import {
  getAlertLink,
  useAlertEvents,
  useAlerts,
  useMarkAlertsRead,
  type UserAlertRecord,
} from '../../facades/alerts/hooks'

const DROPDOWN_ALERT_COUNT = 8

const Bell = () => (
  <svg fill="none" height={18} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" width={18}>
    <path
      d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// Durable-attention bell: badge with the unread count plus a dropdown of
// recent alerts. Channel-derived alert frames invalidate immediately while the
// private categories use the shared short refresh interval.
export const AlertsBell = () => {
  const { focusModeEnabled } = useFocusMode()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { data } = useAlerts({ limit: DROPDOWN_ALERT_COUNT })
  const markRead = useMarkAlertsRead()
  useAlertEvents()

  const alerts = data?.alerts ?? []
  const unreadCount = data?.unreadCount ?? 0

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const openAlert = (alert: UserAlertRecord) => {
    setOpen(false)
    if (!alert.readAt) {
      markRead.mutate({ ids: [alert.id] })
    }
    const link = getAlertLink(alert)
    if (link) {
      navigate(link.to, { state: link.state })
    }
  }

  if (focusModeEnabled) {
    return null
  }

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Alerts"
        className="admin-topbar-btn relative"
        onClick={() => setOpen((value) => !value)}
        title="Alerts"
        type="button"
      >
        <Bell />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1">
            <UnreadBadge value={unreadCount} />
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="admin-topbar-menu max-h-96 overflow-y-auto"
          style={{ left: 'auto', right: 0, width: 320 }}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
              Alerts
            </span>
            <button
              className="text-xs text-[color:var(--accent)] disabled:cursor-default disabled:text-[color:var(--tx3)]"
              disabled={unreadCount === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
              type="button"
            >
              Mark all read
            </button>
          </div>
          {alerts.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[color:var(--tx3)]">No alerts yet</p>
          ) : (
            alerts.map((alert) => (
              <button
                className="admin-topbar-menu-item"
                key={alert.id}
                onClick={() => openAlert(alert)}
                type="button"
              >
                <AlertRow alert={alert} />
              </button>
            ))
          )}
          <button
            className="admin-topbar-menu-item justify-center text-[color:var(--accent)]"
            onClick={() => {
              setOpen(false)
              void navigate('/alerts')
            }}
            type="button"
          >
            See all
          </button>
        </div>
      ) : null}
    </div>
  )
}
