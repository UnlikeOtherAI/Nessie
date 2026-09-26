import type { ExecutorRecordResponse } from '@nessie/schemas'
import { usePrewarm } from '../../../navigation/prewarm'
import { Skeleton } from '../../primitives/Skeleton'
import { ExpandableTable } from '../../shared/ExpandableTable'
import { ExecutorListRow } from './ExecutorListRow'

type ExecutorsTableProps = {
  emptyMessage: string
  executors: ExecutorRecordResponse[]
  isLoading: boolean
  onOpen: (executorId: string) => void
}

const SKELETON_ROWS = 4
const COLUMN_COUNT = 5

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Computers table"
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
      <th className={`${headerClass} pl-4`} scope="col">Computer</th>
      <th className={headerClass} scope="col">Status</th>
      <th className={`${headerClass} hidden md:table-cell`} scope="col">Scope</th>
      <th className={`${headerClass} hidden lg:table-cell`} scope="col">Last seen</th>
      <th className={headerClass} scope="col"><span className="sr-only">Open</span></th>
    </tr>
  </thead>
)

// The zebra-striped, paginated executor table — the same frame the agents list
// uses, through the shared `.admin-table` rules in styles.css. Loading and
// empty states keep that frame so the page does not jump as data arrives.
export const ExecutorsTable = ({
  emptyMessage,
  executors,
  isLoading,
  onOpen,
}: ExecutorsTableProps) => {
  const prewarm = usePrewarm()

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

  if (executors.length === 0) {
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
        {executors.map((executor) => (
          <ExecutorListRow
            executor={executor}
            key={executor.id}
            onOpen={onOpen}
            prewarm={prewarm}
          />
        ))}
      </tbody>
    </TableFrame>
  )
}
