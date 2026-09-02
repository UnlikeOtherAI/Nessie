import type { AgentRecord } from '../../../lib/api-client'
import { usePrewarm } from '../../../navigation/prewarm'
import { Skeleton } from '../../primitives/Skeleton'
import { ExpandableTable } from '../../shared/ExpandableTable'
import { AgentListRow } from './AgentListRow'

type AgentsTableProps = {
  agents: AgentRecord[]
  emptyMessage: string
  isLoading: boolean
  onOpen: (agentId: string) => void
  token: string | null
}

const SKELETON_ROWS = 4

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    label="Agents table"
  >
    <table className="agents-table w-full border-collapse">{children}</table>
  </ExpandableTable>
)

const HeaderRow = () => (
  <thead>
    <tr className="border-b border-[color:var(--sep)]">
      <th
        className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]"
        colSpan={4}
        scope="col"
      >
        Agent
      </th>
    </tr>
  </thead>
)

// The zebra-striped, paginated agent table. Striping and row hover are owned by
// the `.agents-table` rules in styles.css so hover reliably wins over the
// nth-child stripe. Loading and empty states keep the same frame so the tab does
// not jump as data arrives.
export const AgentsTable = ({
  agents,
  emptyMessage,
  isLoading,
  onOpen,
  token,
}: AgentsTableProps) => {
  const prewarm = usePrewarm()

  if (isLoading) {
    return (
      <TableFrame>
        <HeaderRow />
        <tbody>
          <tr>
            <td className="px-4 py-4" colSpan={4}>
              <Skeleton count={SKELETON_ROWS} variant="list" />
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  if (agents.length === 0) {
    return (
      <TableFrame>
        <HeaderRow />
        <tbody>
          <tr>
            <td
              className="px-4 py-12 text-center text-sm text-[color:var(--tx3)]"
              colSpan={4}
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
        {agents.map((agent) => (
          <AgentListRow
            agent={agent}
            key={agent.id}
            onOpen={onOpen}
            prewarm={prewarm}
            token={token}
          />
        ))}
      </tbody>
    </TableFrame>
  )
}
