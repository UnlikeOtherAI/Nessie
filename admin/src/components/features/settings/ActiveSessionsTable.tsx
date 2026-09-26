import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'

import { DEFAULT_PAGE_LIMIT, type SessionSummary } from '@nessie/schemas'
import { useRevokeSession } from '../../../facades/auth/hooks'
import { describeSessionDevice } from '../../../lib/session-device'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../shared/DataTable'
import { EmptyState } from '../../shared/EmptyState'
import { FormError } from '../../shared/FormActions'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { Pill } from '../../primitives/Pill'

type ActiveSessionsTableProps = {
  isLoading: boolean
  sessions: SessionSummary[]
}

const formatWhen = (iso: string): string => new Date(iso).toLocaleString()

/** A screen-bounded session list: paging keeps every revoke decision in view. */
export const ActiveSessionsTable = ({ isLoading, sessions }: ActiveSessionsTableProps) => {
  const { t } = useTranslation('settings')
  const revokeSession = useRevokeSession()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_LIMIT)
  const [error, setError] = useState<string | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<SessionSummary | null>(null)
  const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
  const visiblePage = Math.min(page, totalPages - 1)
  const pageSessions = sessions.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize)

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1))
  }, [totalPages])

  const confirmRevoke = async (session: SessionSummary) => {
    setPendingRevoke(null)
    setError(null)
    try {
      await revokeSession.mutateAsync(session.sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('security.revokeFailed'))
    }
  }

  const rangeStart = sessions.length === 0 ? 0 : visiblePage * pageSize + 1
  const rangeEnd = Math.min((visiblePage + 1) * pageSize, sessions.length)

  const columns: DataTableColumn<SessionSummary>[] = [
    {
      header: t('security.device'),
      key: 'device',
      render: (session) => {
        const device = describeSessionDevice(session)
        return (
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[color:var(--tx)]" title={device.name}>
                {device.name}
              </div>
              <div className="truncate text-xs text-[color:var(--tx3)]" title={device.detail}>
                {device.detail}
                <span className="sm:hidden"> · Last active {formatWhen(session.lastUsedAt)}</span>
              </div>
            </div>
            {session.current ? (
          <Pill radius="chip" size="sm" tone="accent" uppercase={false}>{t('security.thisDevice')}</Pill>
            ) : null}
          </div>
        )
      },
    },
    {
      header: t('security.lastActive'),
      key: 'lastActive',
      render: (session) => <time dateTime={session.lastUsedAt}>{formatWhen(session.lastUsedAt)}</time>,
      secondary: true,
    },
    {
      align: 'right',
      header: t('security.action'),
      key: 'action',
      render: (session) => (
        session.current ? (
        <span className="text-sm text-[color:var(--tx3)]">{t('security.current')}</span>
        ) : (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={revokeSession.isPending}
            onClick={() => setPendingRevoke(session)}
            type="button"
          >
            Revoke
          </button>
        )
      ),
      width: '7rem',
    },
  ]

  return (
    <div>
      <DataTable
        columns={columns}
        empty={<EmptyState>{t('security.noSessions')}</EmptyState>}
        expandable={false}
        label={t('security.sessionsTable')}
        loading={isLoading}
        rowKey={(session) => session.sessionId}
        rows={pageSessions}
        skeletonRows={pageSize}
      />
      <FormError className="mt-2">{error}</FormError>
      {!isLoading && sessions.length > 0 ? (
        <PaginationFooter
          canNext={visiblePage < totalPages - 1}
          canPrevious={visiblePage > 0}
          className="mt-2 border-t-0 px-0 py-0"
          label={t('security.sessionRange', { start: rangeStart, end: rangeEnd, count: sessions.length })}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize)
            setPage(0)
          }}
          page={visiblePage}
          pageCount={totalPages}
          pageSize={pageSize}
        />
      ) : null}

      <ConfirmDialog
        body={
          pendingRevoke
            ? `This signs "${describeSessionDevice(pendingRevoke).name}" out immediately.`
            : undefined
        }
          confirmLabel={t('security.revoke')}
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void confirmRevoke(pendingRevoke)
        }}
        open={pendingRevoke !== null}
          title={t('security.revokeSessionTitle')}
      />
    </div>
  )
}
