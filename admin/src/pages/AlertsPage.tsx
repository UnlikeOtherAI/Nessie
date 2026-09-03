import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertRow } from '../components/shared/AlertRow'
import { PageBody } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { RowList } from '../components/shared/RowList'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import {
  getAlertLink,
  useAttentionSummary,
  useMarkAlertsRead,
  type UserAlertRecord,
} from '../facades/alerts/hooks'
import { useAcceptTeamInvitation } from '../facades/team/invitations'
import { alertKeys } from '../lib/query-keys'
import { usePagedList } from '../facades/usePagedList'

export const AlertsPage = () => {
  const navigate = useNavigate()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const summary = useAttentionSummary()
  // Not a raw key: `alertKeys.all` is the factory; 'page' only distinguishes
  // this hook's own cache entry. See AuditLogPage's identical note. Nested
  // under `alertKeys.all` deliberately, so `useMarkAlertsRead`'s invalidation
  // of that root reaches this page's list too.
  const cacheKey = [...alertKeys.all, 'page']
  const rows = usePagedList<UserAlertRecord>({
    params: { unread: unreadOnly ? 'true' : undefined },
    path: '/api/alerts',
    queryKey: cacheKey,
  })
  const markRead = useMarkAlertsRead()
  const acceptInvitation = useAcceptTeamInvitation()

  const unreadCount = summary.data?.unreadCount ?? 0
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
      <ScreenHeader actions={headerActions} title="Alerts" />

      <PageBody>
        <QueryState
          emptyLabel={unreadOnly ? 'No unread alerts' : 'No alerts yet'}
          errorLabel="Alerts could not be loaded."
          isEmpty={rows.items.length === 0}
          loadingLabel="Loading alerts…"
          query={rows.query}
        >
          {() => (
            <>
              <RowList label="Alerts">
                {rows.items.map((alert) => {
                  const invite = alert.metadata
                  const accepting = acceptInvitation.isPending
                    && acceptInvitation.variables?.inviteId === invite?.inviteId
                  const acceptError = acceptInvitation.isError
                    && acceptInvitation.variables?.inviteId === invite?.inviteId
                    ? acceptInvitation.error.message
                    : null
                  return (
                    <li className="px-3 py-2.5" key={alert.id}>
                      <AlertRow
                        acceptError={acceptError}
                        accepting={accepting}
                        alert={alert}
                        onAcceptInvitation={invite
                          ? () => acceptInvitation.mutate(invite)
                          : undefined}
                        onOpen={() => openAlert(alert)}
                      />
                    </li>
                  )
                })}
              </RowList>
              <PaginationFooter
                canNext={rows.canNext}
                canPrevious={rows.canPrevious}
                hideWhenSinglePage
                label={rows.label}
                onPageChange={rows.onPageChange}
                page={rows.page}
              />
            </>
          )}
        </QueryState>
      </PageBody>
    </section>
  )
}
