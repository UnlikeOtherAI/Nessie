import { Link } from 'react-router-dom'
import { CircleX, SquarePen } from 'lucide-react'
import { Pill } from '../../../components/primitives/Pill'
import {
  useActivateStatus,
  useClearActiveStatus,
  useStatuses,
} from '../../../facades/statuses/hooks'

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
      {statuses.length === 0 ? (
        <Link className="admin-account-menu-row" onClick={onClose} to="/settings/status">
          <SquarePen aria-hidden="true" strokeWidth={2} />
          <span>Set up a status</span>
        </Link>
      ) : (
        <div className="max-h-44 overflow-y-auto">
          {statuses.map((status) => {
            const isActive = status.id === activeStatus?.id
            return (
              <button
                className={`admin-account-menu-row ${isActive ? 'bg-[color:var(--overlay-weak)]' : ''}`}
                disabled={pending}
                key={status.id}
                onClick={() => {
                  if (!isActive) activate.mutate(status.id)
                }}
                type="button"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span aria-hidden className="w-3.5 text-center">
                    {status.emoji ?? '💬'}
                  </span>
                  <span className="truncate">{status.label}</span>
                </span>
                {isActive && (
                  <Pill radius="chip" size="sm" tone="success">
                    Active
                  </Pill>
                )}
              </button>
            )
          })}
        </div>
      )}

      {activeStatus && (
        <button
          className="admin-account-menu-row"
          disabled={pending}
          onClick={() => clear.mutate()}
          type="button"
        >
          <CircleX aria-hidden="true" strokeWidth={2} />
          <span>Clear status</span>
        </button>
      )}

      {statuses.length > 0 && (
        <Link className="admin-account-menu-row" onClick={onClose} to="/settings/status">
          <SquarePen aria-hidden="true" strokeWidth={2} />
          <span>Edit statuses</span>
        </Link>
      )}
    </div>
  )
}
