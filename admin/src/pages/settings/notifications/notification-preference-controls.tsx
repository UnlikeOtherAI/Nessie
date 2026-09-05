import { Switch } from '../../../components/primitives/Switch'
import { SectionLabel } from '../../../components/primitives/SectionLabel'

type PushPreferenceCardProps = {
  disabled: boolean
  pushAssignedWork: boolean
  pushBudgetAlerts: boolean
  pushTriggerHealth: boolean
  setPushTriggerHealth: (value: boolean) => void
  pushEnabled: boolean
  pushMentions: boolean
  pushMessages: boolean
  pushPublishedKnowledge: boolean
  setPushAssignedWork: (next: boolean) => void
  setPushBudgetAlerts: (next: boolean) => void
  setPushEnabled: (next: boolean) => void
  setPushMentions: (next: boolean) => void
  setPushMessages: (next: boolean) => void
  setPushPublishedKnowledge: (next: boolean) => void
}

export const PushPreferenceCard = ({
  disabled,
  pushAssignedWork,
  pushBudgetAlerts,
  pushTriggerHealth,
  setPushTriggerHealth,
  pushEnabled,
  pushMentions,
  pushMessages,
  pushPublishedKnowledge,
  setPushAssignedWork,
  setPushBudgetAlerts,
  setPushEnabled,
  setPushMentions,
  setPushMessages,
  setPushPublishedKnowledge,
}: PushPreferenceCardProps) => (
  <section className="admin-card p-4">
    <SectionLabel>Push</SectionLabel>
    <div className="mt-4 flex items-center justify-between gap-4">
      <div>
        <div className="font-semibold text-[color:var(--tx)]">Push enabled</div>
        <div className="mt-1 text-sm text-[color:var(--tx2)]">
          {pushEnabled ? 'Enabled' : 'Disabled'}
        </div>
      </div>
      <Switch
        checked={pushEnabled}
        disabled={disabled}
        label="Toggle push notifications"
        onChange={setPushEnabled}
      />
    </div>
    <div className="mt-5 border-t border-[color:var(--sep)] pt-4">
      <div className="font-semibold text-[color:var(--tx)]">Notify me about</div>
      <div className="mt-1 text-sm text-[color:var(--tx2)]">
        Every type starts enabled. Nessie skips delivery only when a focused app is already
        showing that exact conversation or page. When you are elsewhere in Nessie, desktop and
        browser sessions show a banner and registered devices receive the system notification.
      </div>
      <div className="mt-4 grid gap-3">
        {[
          {
            checked: pushMessages,
            description: 'New posts in channels you belong to.',
            label: 'Channel messages',
            onChange: setPushMessages,
          },
          {
            checked: pushMentions,
            description: 'Messages that explicitly @mention you.',
            label: 'Mentions',
            onChange: setPushMentions,
          },
          {
            checked: pushBudgetAlerts,
            description: 'Operational budget warnings and blocks for organisation owners.',
            label: 'Budget alerts',
            onChange: setPushBudgetAlerts,
          },
          {
            checked: pushTriggerHealth,
            description: 'A scheduled task that stopped running and needs attention.',
            label: 'Scheduled task failures',
            onChange: setPushTriggerHealth,
          },
          {
            checked: pushAssignedWork,
            description: 'Project work assigned to you by another person.',
            label: 'Assigned work',
            onChange: setPushAssignedWork,
          },
          {
            checked: pushPublishedKnowledge,
            description: 'Knowledge pages newly published where you have access.',
            label: 'Published knowledge',
            onChange: setPushPublishedKnowledge,
          },
        ].map((preference) => (
          <div className="flex items-center justify-between gap-4" key={preference.label}>
            <div>
              <div className="font-medium text-[color:var(--tx)]">{preference.label}</div>
              <div className="mt-0.5 text-sm text-[color:var(--tx2)]">
                {preference.description}
              </div>
            </div>
            <Switch
              checked={preference.checked}
              disabled={!pushEnabled || disabled}
              label={`Toggle ${preference.label.toLowerCase()} notifications`}
              onChange={preference.onChange}
            />
          </div>
        ))}
      </div>
    </div>
  </section>
)
