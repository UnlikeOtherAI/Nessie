import type { PresenceManualState } from '../../../lib/api-client'
import { PresenceBadge } from '../../../components/primitives/PresenceBadge'
import { TabBar } from '../../../components/primitives/TabBar'
import { useSelfPresence } from '../../../providers/PresenceProvider'
import { useFocusMode } from '../../../providers/FocusModeProvider'
import { useTranslation } from 'react-i18next'

type PresenceChoiceKey = 'active' | 'auto' | 'away'

type Choice = { key: PresenceChoiceKey; label: string; manual: PresenceManualState | null }

const CHOICES: Choice[] = [
  { key: 'auto', label: 'auto', manual: null },
  { key: 'active', label: 'active', manual: 'active' },
  { key: 'away', label: 'away', manual: 'away' },
]

// Availability row in the account menu: a live state read-out plus the manual
// override (Auto reverts to automatic activity detection).
export const PresenceControl = () => {
  const self = useSelfPresence()
  const { focusModeEnabled } = useFocusMode()
  const { t } = useTranslation('accountMenu')
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
        <span>{t('availabilityStatus', { status: t(`availabilityState.${self.state === 'online' ? 'active' : self.state === 'away' ? 'away' : 'offline'}`) })}</span>
      </div>
      <TabBar
        ariaLabel="Availability"
        fullWidth
        items={CHOICES.map((choice) => ({
          disabled: self.pending,
          label: t(`availabilityChoice.${choice.label}`),
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
