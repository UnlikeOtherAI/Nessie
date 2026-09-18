import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { UserStatusRecord } from '../../../lib/api-client'
import { Pill } from '../../../components/primitives/Pill'
import { Skeleton } from '../../../components/primitives/Skeleton'
import { ExpandableTable } from '../../../components/shared/ExpandableTable'

type StatusesTableProps = {
  emptyMessage: string
  isLoading: boolean
  onOpen: (statusId: string) => void
  statuses: UserStatusRecord[]
}

const SKELETON_ROWS = 4
const COLUMN_COUNT = 5

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Statuses table"
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
      <th className={`${headerClass} pl-4`} colSpan={2} scope="col">Status</th>
      <th className={`${headerClass} hidden md:table-cell`} scope="col">Schedules</th>
      <th className={`${headerClass} hidden md:table-cell`} scope="col">Contact rules</th>
      <th className={headerClass} scope="col"><span className="sr-only">Open</span></th>
    </tr>
  </thead>
)

// The zebra-striped, paginated status table — the same frame every other
// browsable list in the admin uses, through the shared `.admin-table` rules in
// styles.css.
export const StatusesTable = ({
  emptyMessage,
  isLoading,
  onOpen,
  statuses,
}: StatusesTableProps) => {
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

  if (statuses.length === 0) {
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
        {statuses.map((status) => (
          <tr
            className="cursor-pointer"
            key={status.id}
            onClick={() => onOpen(status.id)}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpen(status.id)
              }
            }}
          >
            <td className="w-9 py-2.5 pl-4 pr-0 text-center align-middle text-base">
              {status.emoji ? <span aria-hidden>{status.emoji}</span> : null}
            </td>
            <td className="min-w-0 px-3 py-2.5 align-middle">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-[color:var(--tx)]">
                  {status.label}
                </span>
                {status.activeNow ? (
                  <Pill height="control" tone="success" uppercase={false}>Active</Pill>
                ) : null}
              </div>
              {status.agentEnabled ? (
                <div className="truncate text-xs text-[color:var(--tx3)]">
                  Response agent answers during this status
                </div>
              ) : null}
            </td>
            <td className="hidden w-28 px-3 py-2.5 align-middle text-xs tabular-nums text-[color:var(--tx2)] md:table-cell">
              {status.schedules.length}
            </td>
            <td className="hidden w-32 px-3 py-2.5 align-middle text-xs tabular-nums text-[color:var(--tx2)] md:table-cell">
              {status.rules.length}
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
