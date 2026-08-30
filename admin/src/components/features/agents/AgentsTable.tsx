import type { AgentRecord } from '../../../lib/api-client'
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
  <div className="overflow-hidden rounded-xl border border-[color:var(--sep)]">
    <table className="agents-table w-full border-collapse">{children}</table>
  </div>
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
  if (isLoading) {
    return (
      <TableFrame>
        <HeaderRow />
        <tbody>
          {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
            <tr key={index}>
              <td className="py-3 pl-4 pr-0">
                <div className="h-8 w-8 animate-pulse rounded-md bg-[color:var(--overlay)]" />
              </td>
              <td className="px-3 py-3">
                <div className="mb-1.5 h-3 w-40 animate-pulse rounded bg-[color:var(--overlay)]" />
                <div className="h-2.5 w-24 animate-pulse rounded bg-[color:var(--overlay-weak)]" />
              </td>
              <td className="hidden sm:table-cell">
                <div className="h-3 w-24 animate-pulse rounded bg-[color:var(--overlay-weak)]" />
              </td>
              <td />
            </tr>
          ))}
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
            token={token}
          />
        ))}
      </tbody>
    </TableFrame>
  )
}
