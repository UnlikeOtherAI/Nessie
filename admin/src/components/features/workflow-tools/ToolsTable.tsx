import type { McpToolRegistryRecord } from '../../../facades/tool-grants/hooks'
import { Skeleton } from '../../primitives/Skeleton'
import { ExpandableTable } from '../../shared/ExpandableTable'
import { ToolListRow } from './ToolListRow'

type ToolsTableProps = {
  emptyMessage: string
  isLoading: boolean
  isReviewable: (tool: McpToolRegistryRecord) => boolean
  onOpen: (toolId: string) => void
  onToggleSelected: (toolId: string) => void
  selectedForReview: ReadonlySet<string>
  tools: McpToolRegistryRecord[]
}

const SKELETON_ROWS = 4
const COLUMN_COUNT = 5

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Tools table"
  >
    {/* Fixed layout, not the shared viewport's `max-content` default: a tool's
        description is a sentence, and letting it size the column pushed the
        Source and Tags columns off the right edge behind a horizontal scroll.
        Fixed columns bound it so the sentence truncates instead. */}
    <table
      className="admin-table w-full border-collapse"
      data-layout="fixed"
      style={{ tableLayout: 'fixed' }}
    >
      {children}
    </table>
  </ExpandableTable>
)

const headerClass = [
  'px-3 py-2 text-left text-[11px] font-semibold uppercase',
  'tracking-[0.12em] text-[color:var(--tx3)]',
].join(' ')

// `table-layout: fixed` sizes every column from this row alone, so each cell
// carries its own width and none of them is a `colSpan` — a spanned header
// leaves the columns under it to be guessed, which starved the tool's name.
const HeaderRow = () => (
  <thead>
    <tr className="border-b border-[color:var(--sep)]">
      <th className={`${headerClass} w-9 pl-4 pr-0`} scope="col">
        <span className="sr-only">Select for review</span>
      </th>
      <th className={headerClass} scope="col">Tool</th>
      <th className={`${headerClass} hidden w-32 md:table-cell`} scope="col">Source</th>
      <th className={`${headerClass} hidden w-40 lg:table-cell`} scope="col">Tags</th>
      <th className={`${headerClass} w-9 pl-0 pr-4`} scope="col">
        <span className="sr-only">Open</span>
      </th>
    </tr>
  </thead>
)

// The zebra-striped, paginated tool table — the same frame the agents,
// executors and triggers lists use, through the shared `.admin-table` rules in
// styles.css. Loading and empty states keep that frame so the page does not
// jump as data arrives or as a filter narrows it.
export const ToolsTable = ({
  emptyMessage,
  isLoading,
  isReviewable,
  onOpen,
  onToggleSelected,
  selectedForReview,
  tools,
}: ToolsTableProps) => {
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

  if (tools.length === 0) {
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
        {tools.map((tool) => (
          <ToolListRow
            key={tool.id}
            onOpen={onOpen}
            onToggleSelected={onToggleSelected}
            reviewable={isReviewable(tool)}
            selectedForReview={selectedForReview.has(tool.id)}
            tool={tool}
          />
        ))}
      </tbody>
    </TableFrame>
  )
}
