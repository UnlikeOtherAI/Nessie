import { Switch } from '../../../components/primitives/Switch'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { useTranslation } from 'react-i18next'

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
}: PushPreferenceCardProps) => {
  const { t } = useTranslation('settings')
  const preferences = [
    { checked: pushMessages, description: t('notifications.channelMessagesDescription'), label: t('notifications.channelMessages'), onChange: setPushMessages },
    { checked: pushMentions, description: t('notifications.mentionsDescription'), label: t('notifications.mentions'), onChange: setPushMentions },
    { checked: pushBudgetAlerts, description: t('notifications.budgetAlertsDescription'), label: t('notifications.budgetAlerts'), onChange: setPushBudgetAlerts },
    { checked: pushTriggerHealth, description: t('notifications.scheduledFailuresDescription'), label: t('notifications.scheduledFailures'), onChange: setPushTriggerHealth },
    { checked: pushAssignedWork, description: t('notifications.assignedWorkDescription'), label: t('notifications.assignedWork'), onChange: setPushAssignedWork },
    { checked: pushPublishedKnowledge, description: t('notifications.publishedKnowledgeDescription'), label: t('notifications.publishedKnowledge'), onChange: setPushPublishedKnowledge },
  ]
  return (
  <section className="admin-card p-4">
    <SectionLabel>{t('notifications.push')}</SectionLabel>
    <div className="mt-4 flex items-center justify-between gap-4">
      <div>
        <div className="font-semibold text-[color:var(--tx)]">{t('notifications.pushEnabled')}</div>
        <div className="mt-1 text-sm text-[color:var(--tx2)]">
        {pushEnabled ? t('common.enabled') : t('common.disabled')}
        </div>
      </div>
      <Switch
        checked={pushEnabled}
        disabled={disabled}
        label={t('notifications.togglePush')}
        onChange={setPushEnabled}
      />
    </div>
    <div className="mt-5 border-t border-[color:var(--sep)] pt-4">
      <div className="font-semibold text-[color:var(--tx)]">{t('notifications.notifyAbout')}</div>
      <div className="mt-1 text-sm text-[color:var(--tx2)]">
        {t('notifications.deliveryDescription')}
      </div>
      <div className="mt-4 grid gap-3">
        {preferences.map((preference) => (
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
                label={t('notifications.toggleSpecific', { label: preference.label.toLowerCase() })}
              onChange={preference.onChange}
            />
          </div>
        ))}
      </div>
    </div>
  </section>
  )
}
