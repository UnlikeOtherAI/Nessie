import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { CommsConnectionSummary } from '../../../lib/api-client'
import { Pill } from '../../../components/primitives/Pill'
import { Skeleton } from '../../../components/primitives/Skeleton'
import { ExpandableTable } from '../../../components/shared/ExpandableTable'
import { PROVIDER_LABEL, STATUS_LABEL, STATUS_TONE } from './ConnectionCard'

type ConnectionsTableProps = {
  connections: CommsConnectionSummary[]
  emptyMessage: string
  isLoading: boolean
  onOpen: (connectionId: string) => void
}

const SKELETON_ROWS = 3
const COLUMN_COUNT = 5

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Connected accounts table"
  >
    <table className="admin-table w-full border-collapse">{children}</table>
  </ExpandableTable>
)

const headerClass = [
  'px-3 py-2 text-left text-[11px] font-semibold uppercase',
  'tracking-[0.12em] text-[color:var(--tx3)]',
].join(' ')

const HeaderRow = () => (
  <thead>
    <tr className="border-b border-[color:var(--sep)]">
      <th className={`${headerClass} pl-4`} scope="col">Account</th>
      <th className={headerClass} scope="col">Status</th>
      <th className={`${headerClass} hidden md:table-cell`} scope="col">Provider</th>
      <th className={`${headerClass} hidden lg:table-cell`} scope="col">Last synced</th>
      <th className={headerClass} scope="col"><span className="sr-only">Open</span></th>
    </tr>
  </thead>
)

const formatSync = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : 'Never'

// The zebra-striped account table, shared by the Email and Slack tabs. Opening
// a row lands on that connection's own screen, which owns its permissions,
// resources and the two destructive controls.
export const ConnectionsTable = ({
  connections,
  emptyMessage,
  isLoading,
  onOpen,
}: ConnectionsTableProps) => {
  if (isLoading) {
    return (
      <TableFrame>
        <HeaderRow />
        <tbody>
          <tr>
            <td className="px-4 py-4" colSpan={COLUMN_COUNT}>
              <Skeleton count={SKELETON_ROWS} variant="list" />
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  if (connections.length === 0) {
    return (
      <TableFrame>
        <HeaderRow />
        <tbody>
          <tr>
            <td
              className="px-4 py-12 text-center text-sm text-[color:var(--tx3)]"
              colSpan={COLUMN_COUNT}
            >
              {emptyMessage}
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  return (
    <TableFrame>
      <HeaderRow />
      <tbody>
        {connections.map((connection) => (
          <tr
            className="cursor-pointer"
            key={connection.id}
            onClick={() => onOpen(connection.id)}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpen(connection.id)
              }
            }}
          >
            <td className="min-w-0 py-2.5 pl-4 pr-3 align-middle">
              <div className="truncate text-sm font-medium text-[color:var(--tx)]">
                {connection.externalUserId}
              </div>
              <div className="truncate text-xs text-[color:var(--tx3)]">
                {connection.syncedResourceCount} of {connection.resourceCount} resources on
              </div>
            </td>
            <td className="w-44 px-3 py-2.5 align-middle">
              <Pill height="control" tone={STATUS_TONE[connection.status]} uppercase={false}>
                {STATUS_LABEL[connection.status]}
              </Pill>
            </td>
            <td className="hidden w-32 px-3 py-2.5 align-middle text-xs text-[color:var(--tx2)] md:table-cell">
              {PROVIDER_LABEL[connection.provider]}
            </td>
            <td className="hidden w-44 px-3 py-2.5 align-middle text-xs text-[color:var(--tx3)] lg:table-cell">
              {formatSync(connection.lastSuccessfulSyncAt)}
            </td>
            <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
              <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={faChevronRight} />
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  )
}
