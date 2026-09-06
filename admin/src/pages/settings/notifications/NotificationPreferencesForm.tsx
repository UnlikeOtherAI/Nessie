import { useMemo, useState, type FormEvent } from 'react'
import type { PushQuietHours, UserPreferences } from '@nessie/schemas'
import type { useUpdatePreferences } from '../../../facades/auth/hooks'
import { requestNotificationPermission } from '../../../facades/notifications/permission'
import { isReactNativeWebView } from '../../../lib/native-shell'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Switch } from '../../../components/primitives/Switch'
import { FeedbackBanner, type SettingsFeedback } from '../FeedbackBanner'
import { BrowserNotificationsSection } from './BrowserNotificationsSection'
import { PushPreferenceCard } from './notification-preference-controls'

const DEFAULT_QUIET_START = '22:00'
const DEFAULT_QUIET_END = '07:00'

const FALLBACK_TIME_ZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
]

type SupportedValuesIntl = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[]
}

const getSupportedTimeZones = (): string[] => {
  const supportedValuesOf = (Intl as SupportedValuesIntl).supportedValuesOf
  return supportedValuesOf ? supportedValuesOf('timeZone') : FALLBACK_TIME_ZONES
}

const getTimeZoneOptions = (selectedTimeZone: string, browserTimeZone: string): string[] => {
  const values = [selectedTimeZone, browserTimeZone, ...getSupportedTimeZones()]
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  )
}

// The preferences PATCH merges per-key, so this owns only the push slice:
// `pushQuietHours: null` clears quiet hours; sibling keys (theme, fontScale,
// starred) are preserved server-side.
const buildPreferencesPayload = (
  input: {
    pushBudgetAlerts: boolean
    pushTriggerHealth: boolean
    pushAssignedWork: boolean
    pushEnabled: boolean
    pushMentions: boolean
    pushMessages: boolean
    pushPublishedKnowledge: boolean
    quietHours: PushQuietHours | null
  },
): UserPreferences => ({
  pushBudgetAlerts: input.pushBudgetAlerts,
  pushTriggerHealth: input.pushTriggerHealth,
  pushAssignedWork: input.pushAssignedWork,
  pushEnabled: input.pushEnabled,
  pushMentions: input.pushMentions,
  pushMessages: input.pushMessages,
  pushPublishedKnowledge: input.pushPublishedKnowledge,
  pushQuietHours: input.quietHours,
})

type NotificationPreferencesFormProps = {
  browserTimeZone: string
  /**
   * Required, never `| undefined`: the parent mounts this only once `me` has
   * loaded, keyed on `me.user.id`, and passes `me.user.preferences ?? {}` —
   * every field of `UserPreferences` is itself optional, so the empty object
   * is a valid "nothing saved yet" value. Every field below reads its
   * `useState` initializer straight from this prop, so a user switch (a new
   * `key`) remounts the form with the new user's values instead of needing a
   * hydration effect to copy them in after the fact.
   */
  preferences: UserPreferences
  updatePreferences: ReturnType<typeof useUpdatePreferences>
}

/**
 * The saved notification-preferences form: push toggles, quiet hours, and
 * browser (Web Push) notifications. Split out of `NotificationsPage.tsx`
 * (05-F9 / 06-F4), which hydrated these eleven fields into `useState` via a
 * ref-guarded effect — remounting on `key={me.user.id}` replaces that with
 * plain `useState(() => …)` initializers.
 */
export const NotificationPreferencesForm = ({
  browserTimeZone,
  preferences,
  updatePreferences,
}: NotificationPreferencesFormProps) => {
  const [pushEnabled, setPushEnabled] = useState(() => preferences.pushEnabled ?? true)
  const [pushMessages, setPushMessages] = useState(() => preferences.pushMessages ?? true)
  const [pushMentions, setPushMentions] = useState(() => preferences.pushMentions ?? true)
  const [pushBudgetAlerts, setPushBudgetAlerts] = useState(
    () => preferences.pushBudgetAlerts ?? true,
  )
  const [pushTriggerHealth, setPushTriggerHealth] = useState(
    () => preferences.pushTriggerHealth ?? true,
  )
  const [pushAssignedWork, setPushAssignedWork] = useState(
    () => preferences.pushAssignedWork ?? true,
  )
  const [pushPublishedKnowledge, setPushPublishedKnowledge] = useState(
    () => preferences.pushPublishedKnowledge ?? true,
  )
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(
    () => Boolean(preferences.pushQuietHours),
  )
  const [quietStart, setQuietStart] = useState(
    () => preferences.pushQuietHours?.start ?? DEFAULT_QUIET_START,
  )
  const [quietEnd, setQuietEnd] = useState(
    () => preferences.pushQuietHours?.end ?? DEFAULT_QUIET_END,
  )
  const [quietTimezone, setQuietTimezone] = useState(
    () => preferences.pushQuietHours?.timezone ?? browserTimeZone,
  )
  const [preferenceFeedback, setPreferenceFeedback] = useState<SettingsFeedback | null>(null)

  const timeZoneOptions = useMemo(
    () => getTimeZoneOptions(quietTimezone, browserTimeZone),
    [browserTimeZone, quietTimezone],
  )

  const savePreferences = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Submitting the form is a user gesture, so this is a safe point to ask for
    // native notification permission when push is on (Safari rejects off-gesture
    // requests). No-op once permission is already granted or denied.
    //
    // Not inside the native shell: there the save is a bar button, and the
    // submit is driven by `requestSubmit()` from a bridge message, which
    // carries no transient activation — so the request would be refused rather
    // than shown. The shell registers for push through its own native path
    // (`nessie:request-push-registration`), which is where that belongs.
    if (pushEnabled && !isReactNativeWebView()) {
      requestNotificationPermission()
    }
    setPreferenceFeedback(null)

    const quietHours = quietHoursEnabled
      ? {
          end: quietEnd,
          start: quietStart,
          timezone: quietTimezone,
        }
      : null

    try {
      await updatePreferences.mutateAsync(buildPreferencesPayload({
        pushBudgetAlerts,
        pushTriggerHealth,
        pushAssignedWork,
        pushEnabled,
        pushMentions,
        pushMessages,
        pushPublishedKnowledge,
        quietHours,
      }))
      setPreferenceFeedback({ kind: 'success', message: 'Notification preferences saved.' })
    } catch (error) {
      setPreferenceFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to save notification preferences.',
      })
    }
  }

  return (
    <form
      className="grid gap-4"
      id="notification-preferences-form"
      onSubmit={savePreferences}
    >
      <PushPreferenceCard
        disabled={updatePreferences.isPending}
        pushAssignedWork={pushAssignedWork}
        pushBudgetAlerts={pushBudgetAlerts}
        pushTriggerHealth={pushTriggerHealth}
        pushEnabled={pushEnabled}
        pushMentions={pushMentions}
        pushMessages={pushMessages}
        pushPublishedKnowledge={pushPublishedKnowledge}
        setPushAssignedWork={setPushAssignedWork}
        setPushBudgetAlerts={setPushBudgetAlerts}
        setPushTriggerHealth={setPushTriggerHealth}
        setPushEnabled={(next) => {
          setPushEnabled(next)
          // A real tap on the switch, so this one keeps its gesture on
          // every surface.
          if (next) {
            requestNotificationPermission()
          }
        }}
        setPushMentions={setPushMentions}
        setPushMessages={setPushMessages}
        setPushPublishedKnowledge={setPushPublishedKnowledge}
      />

      <section className="admin-card p-4">
        <SectionLabel>Quiet hours</SectionLabel>
        <div className="mt-4 flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-[color:var(--tx)]">Quiet hours</div>
            <div className="mt-1 text-sm text-[color:var(--tx2)]">
              {quietHoursEnabled ? 'Enabled' : 'Disabled'}
            </div>
          </div>
          <Switch
            checked={quietHoursEnabled}
            disabled={updatePreferences.isPending}
            label="Toggle quiet hours"
            onChange={setQuietHoursEnabled}
          />
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
            Start
            <input
              className="admin-input"
              disabled={!quietHoursEnabled || updatePreferences.isPending}
              onChange={(event) => setQuietStart(event.target.value)}
              required={quietHoursEnabled}
              type="time"
              value={quietStart}
            />
          </label>
          <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
            End
            <input
              className="admin-input"
              disabled={!quietHoursEnabled || updatePreferences.isPending}
              onChange={(event) => setQuietEnd(event.target.value)}
              required={quietHoursEnabled}
              type="time"
              value={quietEnd}
            />
          </label>
          <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
            Timezone
            <select
              className="admin-input"
              disabled={!quietHoursEnabled || updatePreferences.isPending}
              onChange={(event) => setQuietTimezone(event.target.value)}
              required={quietHoursEnabled}
              value={quietTimezone}
            >
              {timeZoneOptions.map((timeZone) => (
                <option key={timeZone} value={timeZone}>
                  {timeZone}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <BrowserNotificationsSection />

      <FeedbackBanner feedback={preferenceFeedback} />
    </form>
  )
}
