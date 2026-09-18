import type { AgentTriggerRecord } from '../../../lib/api-client'
import { Skeleton } from '../../primitives/Skeleton'
import { ExpandableTable } from '../../shared/ExpandableTable'
import { TriggerListRow } from './TriggerListRow'
import type { TriggerRegistryMaps } from './trigger-presentation'

type TriggersTableProps = {
  emptyMessage: string
  isLoading: boolean
  onOpen: (triggerId: string) => void
  registry: TriggerRegistryMaps
  triggers: AgentTriggerRecord[]
}

const SKELETON_ROWS = 4
const COLUMN_COUNT = 6

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Triggers table"
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
      <th className={`${headerClass} pl-4`} colSpan={2} scope="col">Trigger</th>
      <th className={headerClass} scope="col">Status</th>
      <th className={`${headerClass} hidden md:table-cell`} scope="col">Type</th>
      <th className={`${headerClass} hidden lg:table-cell`} scope="col">Next run</th>
      <th className={headerClass} scope="col"><span className="sr-only">Open</span></th>
    </tr>
  </thead>
)

// The zebra-striped, paginated trigger table — the same frame the agents and
// executors lists use, through the shared `.admin-table` rules in styles.css.
// Loading and empty states keep that frame so the page does not jump as data
// arrives or as a filter narrows it.
export const TriggersTable = ({
  emptyMessage,
  isLoading,
  onOpen,
  registry,
  triggers,
}: TriggersTableProps) => {
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

  if (triggers.length === 0) {
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
        {triggers.map((trigger) => (
          <TriggerListRow
            key={trigger.id}
            onOpen={onOpen}
            registry={registry}
            trigger={trigger}
          />
        ))}
      </tbody>
    </TableFrame>
  )
}
