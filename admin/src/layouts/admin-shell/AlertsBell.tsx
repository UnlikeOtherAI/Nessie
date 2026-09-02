import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover } from '../../components/overlays/Popover'
import { AlertRow } from '../../components/shared/AlertRow'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { UnreadBadge } from '../../components/primitives/UnreadBadge'
import { useFocusMode } from '../../providers/FocusModeProvider'
import {
  getAlertLink,
  useAlertEvents,
  useAlerts,
  useMarkAlertsRead,
  type UserAlertRecord,
} from '../../facades/alerts/hooks'
import { useAcceptWorkspaceInvitation } from '../../facades/workspace/invitations'

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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { data } = useAlerts({ limit: DROPDOWN_ALERT_COUNT })
  const markRead = useMarkAlertsRead()
  const acceptInvitation = useAcceptWorkspaceInvitation()
  useAlertEvents()

  const alerts = data?.alerts ?? []
  const unreadCount = data?.unreadCount ?? 0

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
    <div className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Alerts"
        className="admin-topbar-btn relative"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
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
      <Popover
        anchorRef={triggerRef}
        className="admin-topbar-menu max-h-96 overflow-y-auto"
        label="Alerts"
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-end"
        role="menu"
        style={{ width: 320 }}
      >
        <div className="flex items-center justify-between px-2 py-1">
          <SectionLabel as="span">Alerts</SectionLabel>
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
          alerts.map((alert) => {
            const invite = alert.metadata
            const accepting = acceptInvitation.isPending
              && acceptInvitation.variables?.inviteId === invite?.inviteId
            const acceptError = acceptInvitation.isError
              && acceptInvitation.variables?.inviteId === invite?.inviteId
              ? acceptInvitation.error.message
              : null
            return (
              <AlertRow
                acceptError={acceptError}
                accepting={accepting}
                alert={alert}
                className="admin-topbar-menu-item"
                key={alert.id}
                onAcceptInvitation={invite
                  ? () => acceptInvitation.mutate(invite)
                  : undefined}
                onOpen={() => openAlert(alert)}
              />
            )
          })
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
      </Popover>
    </div>
  )
}
