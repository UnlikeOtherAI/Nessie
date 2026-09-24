import { useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronRight, faPlus } from '@fortawesome/free-solid-svg-icons'
import type { ExecutorRecordResponse } from '@nessie/schemas'
import { Popover } from '../../../components/overlays/Popover'
import { useExecutors } from '../../../facades/executors/hooks'
import { executorGroupStatus } from '../../../facades/executors/status'

const rowClass = 'flex min-h-10 items-center gap-2 rounded-lg px-2.5 py-2 text-sm '
  + 'text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]'

const StatusDot = ({ executors }: { executors: ExecutorRecordResponse[] }) => {
  const status = executorGroupStatus(executors)
  return <span aria-label={status.label} className="h-2 w-2 shrink-0 rounded-full" role="img"
    style={{ backgroundColor: `var(${status.token})` }} />
}

/** The label navigates; its separate disclosure control opens the machine list. */
export const ExecutorMenuGroup = ({
  executors, kind, onClose,
}: {
  executors: ExecutorRecordResponse[]
  kind: 'personal' | 'team'
  onClose: () => void
}) => {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const title = kind === 'personal' ? 'Executors' : 'Team executors'
  const addLabel = kind === 'personal' ? 'Add Personal Executor' : 'Add Team Executor'
  if (executors.length === 0) return (
    <Link className={rowClass} onClick={onClose} role="menuitem" to={`/agents/executors?create=${kind}`}>
      <StatusDot executors={executors} /><span className="flex-1">{addLabel}</span>
      <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={faPlus} />
    </Link>
  )
  return (
    <>
      <div className="flex items-center" ref={anchor}>
        <Link aria-label={title} className={`${rowClass} min-w-0 flex-1`} onClick={onClose} role="menuitem" to="/agents/executors">
          <StatusDot executors={executors} /><span>{title}</span>
        </Link>
        <button aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="menu"
          aria-label={`Show ${kind} executors`} className={`${rowClass} justify-center`}
          onClick={() => setOpen((value) => !value)} ref={trigger} type="button">
          <FontAwesomeIcon className="h-3 w-3" icon={faChevronRight} />
        </button>
      </div>
      <Popover anchorRef={anchor} id={id} label={`${kind === 'personal' ? 'Personal' : 'Team'} executors`}
        className="w-64 overflow-y-auto rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5 shadow-xl"
        onClose={() => setOpen(false)} open={open} placement="right" returnFocusRef={trigger} role="menu">
        {executors.map((executor) => (
          <Link className={rowClass} key={executor.id} onClick={() => { setOpen(false); onClose() }}
            role="menuitem" to={`/agents/executors/${executor.id}`}>
            <StatusDot executors={[executor]} />
            <span className="min-w-0 flex-1 truncate">{executor.label}</span>
            <span className="text-xs capitalize text-[color:var(--tx3)]">{executor.status.replaceAll('_', ' ')}</span>
          </Link>
        ))}
      </Popover>
    </>
  )
}

export const ExecutorSection = ({ onClose }: { onClose: () => void }) => {
  const inventory = useExecutors()
  if (inventory.isPending) return <p className="px-2.5 py-2 text-sm text-[color:var(--tx3)]">Loading executors…</p>
  if (inventory.isError) return (
    <Link className={rowClass} onClick={onClose} role="menuitem" to="/agents/executors">Executor status unavailable</Link>
  )
  return <>
    <ExecutorMenuGroup executors={inventory.data.filter((executor) => executor.scope.kind === 'private')}
      kind="personal" onClose={onClose} />
    <ExecutorMenuGroup executors={inventory.data.filter((executor) => executor.scope.kind !== 'private')}
      kind="team" onClose={onClose} />
  </>
}
