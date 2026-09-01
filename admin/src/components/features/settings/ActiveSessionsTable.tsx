import { useEffect, useState } from 'react'

import type { SessionSummary } from '@nessie/schemas'
import { useRevokeSession } from '../../../facades/auth/hooks'
import { describeSessionDevice } from '../../../pages/settings/session-device'
import { ExpandableTable } from '../../shared/ExpandableTable'
import { PaginationFooter } from '../../shared/PaginationFooter'

type ActiveSessionsTableProps = {
  isLoading: boolean
  sessions: SessionSummary[]
}

const PAGE_SIZE = 6

const formatWhen = (iso: string): string => new Date(iso).toLocaleString()

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <div className="overflow-hidden rounded-xl border border-[color:var(--sep)]">
    {children}
  </div>
)

/** A screen-bounded session list: paging keeps every revoke decision in view. */
export const ActiveSessionsTable = ({ isLoading, sessions }: ActiveSessionsTableProps) => {
  const revokeSession = useRevokeSession()
  const [page, setPage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE))
  const visiblePage = Math.min(page, totalPages - 1)
  const pageSessions = sessions.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE)

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1))
  }, [totalPages])

  const revoke = async (sessionId: string) => {
    setError(null)
    try {
      await revokeSession.mutateAsync(sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to revoke session.')
    }
  }

  const rangeStart = sessions.length === 0 ? 0 : visiblePage * PAGE_SIZE + 1
  const rangeEnd = Math.min((visiblePage + 1) * PAGE_SIZE, sessions.length)

  return (
    <TableFrame>
      <ExpandableTable label="Active sessions table">
        <table className="admin-table w-full table-fixed border-collapse">
          <caption className="sr-only">Active devices signed in to your account</caption>
          <thead>
            <tr className="border-b border-[color:var(--sep)]">
              <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
                Device
              </th>
              <th className="hidden w-44 px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)] sm:table-cell" scope="col">
                Last active
              </th>
              <th className="w-28 px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: PAGE_SIZE }).map((_, index) => (
                <tr key={index}>
                  <td className="px-4 py-3">
                    <div className="mb-2 h-4 max-w-52 animate-pulse rounded bg-[color:var(--overlay)]" />
                    <div className="h-3 w-28 animate-pulse rounded bg-[color:var(--overlay-weak)]" />
                  </td>
                  <td className="hidden px-4 py-3 sm:table-cell"><div className="h-3 w-28 animate-pulse rounded bg-[color:var(--overlay-weak)]" /></td>
                  <td className="px-4 py-3"><div className="ml-auto h-8 w-16 animate-pulse rounded bg-[color:var(--overlay)]" /></td>
                </tr>
              ))
            ) : sessions.length === 0 ? (
              <tr>
                <td className="px-4 py-12 text-center text-sm text-[color:var(--tx3)]" colSpan={3}>
                  No active sessions.
                </td>
              </tr>
            ) : (
              pageSessions.map((session) => {
                const device = describeSessionDevice(session)
                return (
                  <tr className="border-b border-[color:var(--sep)] last:border-b-0" key={session.sessionId}>
                    <td className="min-w-0 px-4 py-3 align-middle">
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
                          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em] bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
                            This device
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 text-sm text-[color:var(--tx2)] sm:table-cell">
                      <time dateTime={session.lastUsedAt}>{formatWhen(session.lastUsedAt)}</time>
                    </td>
                    <td className="px-4 py-3 text-right align-middle">
                      {session.current ? (
                        <span className="text-sm text-[color:var(--tx3)]">Current</span>
                      ) : (
                        <button
                          className="admin-button admin-button-secondary admin-button-compact"
                          disabled={revokeSession.isPending}
                          onClick={() => void revoke(session.sessionId)}
                          type="button"
                        >
                          {revokeSession.isPending ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </ExpandableTable>
      {error ? <div className="border-t border-[color:var(--sep)] px-4 py-2 text-sm text-[color:var(--danger-text)]" role="alert">{error}</div> : null}
      <PaginationFooter
        canNext={!isLoading && visiblePage < totalPages - 1}
        canPrevious={!isLoading && visiblePage > 0}
        className="px-4 py-2"
        label={
          isLoading
            ? 'Loading sessions'
            : sessions.length === 0
              ? 'No sessions'
              : `${rangeStart}–${rangeEnd} of ${sessions.length} · Page ${visiblePage + 1} of ${totalPages}`
        }
        onPageChange={setPage}
        page={visiblePage}
      />
    </TableFrame>
  )
}
