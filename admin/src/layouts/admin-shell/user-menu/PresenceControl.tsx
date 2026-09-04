import type { PresenceManualState } from '../../../lib/api-client'
import { PresenceBadge } from '../../../components/primitives/PresenceBadge'
import { TabBar } from '../../../components/primitives/TabBar'
import { useSelfPresence } from '../../../providers/PresenceProvider'
import { useFocusMode } from '../../../providers/FocusModeProvider'

type PresenceChoiceKey = 'active' | 'auto' | 'away'

type Choice = { key: PresenceChoiceKey; label: string; manual: PresenceManualState | null }

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
  const { focusModeEnabled } = useFocusMode()
  if (!self) return null

  const current: PresenceChoiceKey = self.manual ?? 'auto'
  const chooseAvailability = (key: PresenceChoiceKey) => {
    const choice = CHOICES.find((candidate) => candidate.key === key)
    if (choice) self.setManual(choice.manual)
  }

  return (
    <div className="px-2 py-1.5">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-[color:var(--tx3)]">
        <PresenceBadge focusModeEnabled={focusModeEnabled} ringColor="var(--panel)" size={9} state={self.state} />
        <span>Availability — {STATE_LABEL[self.state] ?? 'Active'}</span>
      </div>
      <TabBar
        ariaLabel="Availability"
        fullWidth
        items={CHOICES.map((choice) => ({
          disabled: self.pending,
          label: choice.label,
          value: choice.key,
        }))}
        onChange={chooseAvailability}
        role="radiogroup"
        size="sm"
        value={current}
      />
    </div>
  )
}
