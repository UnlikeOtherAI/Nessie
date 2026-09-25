import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { ExecutorRecordResponse } from '@nessie/schemas'
import { prewarmRowHandlers } from '../../../navigation/prewarm'
import { Pill } from '../../primitives/Pill'
import {
  EXECUTOR_STATUS_LABELS,
  executorProfilesLabel,
  executorScopeLabel,
  executorStatusTone,
} from './executor-presentation'

type ExecutorListRowProps = {
  executor: ExecutorRecordResponse
  onOpen: (executorId: string) => void
  /** From the table's own `usePrewarm()`; a row cannot call a hook itself. */
  prewarm: (to: string) => void
}

const lastSeenLabel = (executor: ExecutorRecordResponse): string =>
  executor.lastSeenAt ? new Date(executor.lastSeenAt).toLocaleString() : 'Never'

// One executor row: the machine's name over its approved profiles, the status
// it is in, how it is reached, when it last checked in, and a far-right
// chevron. The whole row opens executor detail, which owns access, operations
// and this computer's own companion controls.
export const ExecutorListRow = ({ executor, onOpen, prewarm }: ExecutorListRowProps) => (
  <tr
    className="cursor-pointer"
    onClick={() => onOpen(executor.id)}
    tabIndex={0}
    {...prewarmRowHandlers(prewarm, `/agents/executors/${executor.id}`)}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpen(executor.id)
      }
    }}
  >
    <td className="min-w-0 py-2.5 pl-4 pr-3 align-middle">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">{executor.label}</span>
      </div>
      <div className="truncate text-xs text-[color:var(--tx3)]">
        {executorProfilesLabel(executor)}
      </div>
    </td>
    <td className="w-36 px-3 py-2.5 align-middle">
      <Pill height="control" tone={executorStatusTone(executor.status)} uppercase={false}>
        {EXECUTOR_STATUS_LABELS[executor.status]}
      </Pill>
    </td>
    <td className="hidden w-32 px-3 py-2.5 align-middle text-xs text-[color:var(--tx2)] md:table-cell">
      {executorScopeLabel(executor)}
    </td>
    <td className="hidden w-44 px-3 py-2.5 align-middle text-xs text-[color:var(--tx3)] lg:table-cell">
      {lastSeenLabel(executor)}
    </td>
    <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
      <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={faChevronRight} />
    </td>
  </tr>
)
