import type { PresenceManualState } from '../../../lib/api-client'
import { PresenceBadge } from '../../../components/primitives/PresenceBadge'
import { useSelfPresence } from '../../../providers/PresenceProvider'

type Choice = { key: string; label: string; manual: PresenceManualState | null }

const CHOICES: Choice[] = [
  { key: 'auto', label: 'Auto', manual: null },
  { key: 'active', label: 'Active', manual: 'active' },
  { key: 'away', label: 'Away', manual: 'away' },
]

const STATE_LABEL: Record<string, string> = {
  online: 'Active',
  away: 'Away',
  offline: 'Offline',
}

// Availability row in the account menu: a live state read-out plus the manual
// override (Auto reverts to automatic activity detection).
export const PresenceControl = () => {
  const self = useSelfPresence()
  if (!self) return null

  const current = self.manual ?? 'auto'

  return (
    <div className="px-2 py-1.5">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-[color:var(--tx3)]">
        <PresenceBadge ringColor="var(--panel)" size={9} state={self.state} />
        <span>Availability — {STATE_LABEL[self.state] ?? 'Active'}</span>
      </div>
      <div className="flex gap-1 rounded-lg bg-[color:var(--overlay-weak)] p-0.5">
        {CHOICES.map((choice) => {
          const active = current === choice.key
          return (
            <button
              className={[
                'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                  : 'text-[color:var(--tx2)] hover:text-[color:var(--tx)]',
              ].join(' ')}
              disabled={self.pending}
              key={choice.key}
              onClick={() => self.setManual(choice.manual)}
              type="button"
            >
              {choice.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
