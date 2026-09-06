import { Link } from 'react-router-dom'
import type { UserStatusRecord } from '../../../lib/api-client'
import { Pill } from '../../../components/primitives/Pill'
import { hoverCardClass } from '../settings-presentation'

export const StatusList = ({
  activeId,
  statuses,
}: {
  activeId?: string
  statuses: UserStatusRecord[]
}) => (
  <div className="grid gap-2">
    {statuses.map((status) => (
      <Link
        key={status.id}
        className={[
          hoverCardClass,
          activeId === status.id ? 'border-[color:var(--accent)]' : '',
        ].join(' ')}
        to={`/settings/statuses/${status.id}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold text-[color:var(--tx)]">
              {status.emoji && <span aria-hidden>{status.emoji}</span>}
              <span className="truncate">{status.label}</span>
            </div>
            <div className="mt-1 text-xs text-[color:var(--tx3)]">
              {status.schedules.length} schedule{status.schedules.length === 1 ? '' : 's'} ·{' '}
              {status.rules.length} rule{status.rules.length === 1 ? '' : 's'}
            </div>
          </div>
          {status.activeNow && (
            <Pill radius="chip" tone="success" uppercase={false}>
              Active
            </Pill>
          )}
        </div>
      </Link>
    ))}
  </div>
)
