import { Link } from 'react-router-dom'
import { faCircleXmark, faPenToSquare } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  useActivateStatus,
  useClearActiveStatus,
  useStatuses,
} from '../../../facades/statuses/hooks'

const rowClassName = [
  'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left',
  'text-sm text-[color:var(--tx)] transition-colors hover:bg-[color:var(--overlay-weak)]',
].join(' ')

// Status block in the account menu: lists the user's statuses (tap to activate),
// surfaces a clear action when one is active, and links to the full editor. With
// no statuses yet it collapses to a single set-up link.
export const StatusSection = ({ onClose }: { onClose: () => void }) => {
  const { data: statuses = [] } = useStatuses()
  const activate = useActivateStatus()
  const clear = useClearActiveStatus()

  const activeStatus = statuses.find((status) => status.activeNow)
  const pending = activate.isPending || clear.isPending

  return (
    <div>
      <div className="px-2 pb-0.5 pt-1 text-xs font-medium text-[color:var(--tx3)]">Status</div>

      {statuses.length === 0 ? (
        <Link className={rowClassName} onClick={onClose} to="/settings/statuses">
          <span className="text-[color:var(--tx2)]">Set up a status</span>
          <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--tx3)]" icon={faPenToSquare} />
        </Link>
      ) : (
        <div className="max-h-44 overflow-y-auto">
          {statuses.map((status) => {
            const isActive = status.id === activeStatus?.id
            return (
              <button
                className={[
                  rowClassName,
                  isActive ? 'bg-[color:var(--overlay-weak)]' : '',
                ].join(' ')}
                disabled={pending}
                key={status.id}
                onClick={() => {
                  if (!isActive) activate.mutate(status.id)
                }}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="w-5 text-center">
                    {status.emoji ?? '💬'}
                  </span>
                  <span className="truncate">{status.label}</span>
                </span>
                {isActive && (
                  <span className="rounded bg-[color:var(--success-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[color:var(--success-text)]">
                    Active
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {activeStatus && (
        <button
          className={rowClassName}
          disabled={pending}
          onClick={() => clear.mutate()}
          type="button"
        >
          <span className="text-[color:var(--tx2)]">Clear status</span>
          <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--tx3)]" icon={faCircleXmark} />
        </button>
      )}

      {statuses.length > 0 && (
        <Link className={rowClassName} onClick={onClose} to="/settings/statuses">
          <span className="text-[color:var(--tx2)]">Edit statuses</span>
          <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--tx3)]" icon={faPenToSquare} />
        </Link>
      )}
    </div>
  )
}
