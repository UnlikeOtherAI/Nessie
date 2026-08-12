import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { PushQuietHours, UserPreferences } from '@nessie/schemas'
import { useUpdatePreferences } from '../../facades/auth/hooks'
import { useChannels, useSetChannelMute } from '../../facades/channels/hooks'
import { requestNotificationPermission } from '../../facades/notifications/permission'
import {
  useSubscribeWebPush,
  useUnsubscribeWebPush,
  useWebPushConfig,
} from '../../facades/web-push/hooks'
import {
  getExistingSubscription,
  isWebPushSupported,
  subscribeBrowser,
  unsubscribeBrowser,
} from '../../lib/web-push'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import {
  NotificationToggle,
  PushPreferenceCard,
} from './notification-preference-controls'
import { FeedbackBanner, type SettingsFeedback, sectionTitleClass, SettingsPanel } from './settings-shared'

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

const getBrowserTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

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
    pushAssignedWork: boolean
    pushEnabled: boolean
    pushMentions: boolean
    pushMessages: boolean
    pushPublishedKnowledge: boolean
    quietHours: PushQuietHours | null
  },
): UserPreferences => ({
  pushBudgetAlerts: input.pushBudgetAlerts,
  pushAssignedWork: input.pushAssignedWork,
  pushEnabled: input.pushEnabled,
  pushMentions: input.pushMentions,
  pushMessages: input.pushMessages,
  pushPublishedKnowledge: input.pushPublishedKnowledge,
  pushQuietHours: input.quietHours,
})

const getNotificationPermission = (): NotificationPermission | null =>
  typeof Notification === 'undefined' ? null : Notification.permission

// Browser (Web Push) notifications. Independent from the saved push
// preferences above: this manages the per-browser PushManager subscription and
// mirrors it to the API. Gracefully degrades when the browser lacks support or
// when web push is not configured on this instance.
const BrowserNotificationsSection = () => {
  const { data: config, isLoading: configLoading } = useWebPushConfig()
  const subscribeWebPush = useSubscribeWebPush()
  const unsubscribeWebPush = useUnsubscribeWebPush()

  const [supported] = useState(() => isWebPushSupported())
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  useEffect(() => {
    if (!supported) {
      return
    }
    let cancelled = false
    void getExistingSubscription().then((subscription) => {
      if (!cancelled) {
        setSubscribed(Boolean(subscription))
      }
    })
    return () => {
      cancelled = true
    }
  }, [supported])

  const configEnabled = config?.enabled === true
  const publicKey = config?.publicKey ?? null
  const denied = supported && getNotificationPermission() === 'denied'
  const toggleDisabled = !supported || configLoading || !configEnabled || denied || busy

  const describeState = (): string => {
    if (!supported) {
      return 'This browser does not support web push notifications.'
    }
    if (configLoading) {
      return 'Checking availability...'
    }
    if (!configEnabled) {
      return 'Browser notifications are not configured on this instance.'
    }
    if (denied) {
      return 'Notifications are blocked. Allow them in your browser settings to enable.'
    }
    return subscribed ? 'Enabled on this browser' : 'Disabled'
  }

  const handleToggle = async (next: boolean) => {
    setFeedback(null)
    setBusy(true)
    try {
      if (next) {
        if (!publicKey) {
          throw new Error('Browser notifications are not configured on this instance.')
        }
        const subscription = await subscribeBrowser(publicKey)
        await subscribeWebPush.mutateAsync(subscription)
        setSubscribed(true)
        setFeedback({ kind: 'success', message: 'Browser notifications enabled.' })
      } else {
        const endpoint = await unsubscribeBrowser()
        if (endpoint) {
          await unsubscribeWebPush.mutateAsync({ endpoint })
        }
        setSubscribed(false)
        setFeedback({ kind: 'success', message: 'Browser notifications disabled.' })
      }
    } catch (error) {
      setFeedback({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Failed to update browser notifications.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-card p-4">
      <div className={sectionTitleClass}>Browser notifications</div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <div className="font-semibold text-[color:var(--tx)]">Browser notifications</div>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">{describeState()}</div>
        </div>
        <NotificationToggle
          checked={subscribed}
          disabled={toggleDisabled}
          label="Toggle browser notifications"
          onChange={(next) => void handleToggle(next)}
        />
      </div>
      <div className="mt-3">
        <FeedbackBanner feedback={feedback} />
      </div>
    </section>
  )
}

export const NotificationsPage = () => {
  const { me } = useAuthSession()
  const { data: channels = [] } = useChannels()
  const browserTimeZone = useMemo(() => getBrowserTimeZone(), [])
  const updatePreferences = useUpdatePreferences()
  const setChannelMute = useSetChannelMute()

  const [pushEnabled, setPushEnabled] = useState(true)
  const [pushMessages, setPushMessages] = useState(true)
  const [pushMentions, setPushMentions] = useState(true)
  const [pushBudgetAlerts, setPushBudgetAlerts] = useState(true)
  const [pushAssignedWork, setPushAssignedWork] = useState(true)
  const [pushPublishedKnowledge, setPushPublishedKnowledge] = useState(true)
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false)
  const [quietStart, setQuietStart] = useState(DEFAULT_QUIET_START)
  const [quietEnd, setQuietEnd] = useState(DEFAULT_QUIET_END)
  const [quietTimezone, setQuietTimezone] = useState(browserTimeZone)
  const [preferencesHydrated, setPreferencesHydrated] = useState(false)
  const [preferenceFeedback, setPreferenceFeedback] = useState<SettingsFeedback | null>(null)
  const [channelFeedback, setChannelFeedback] = useState<SettingsFeedback | null>(null)
  const [channelMuteOverrides, setChannelMuteOverrides] = useState<Record<string, boolean>>({})
  const hydratedUserId = useRef<string | null>(null)

  useEffect(() => {
    if (!me) {
      setPreferencesHydrated(false)
      hydratedUserId.current = null
      return
    }
    if (hydratedUserId.current === me.user.id) return
    const preferences = me?.user.preferences
    const quietHours = preferences?.pushQuietHours

    setPushEnabled(preferences?.pushEnabled ?? true)
    setPushMessages(preferences?.pushMessages ?? true)
    setPushMentions(preferences?.pushMentions ?? true)
    setPushBudgetAlerts(preferences?.pushBudgetAlerts ?? true)
    setPushAssignedWork(preferences?.pushAssignedWork ?? true)
    setPushPublishedKnowledge(preferences?.pushPublishedKnowledge ?? true)
    setQuietHoursEnabled(Boolean(quietHours))
    setQuietStart(quietHours?.start ?? DEFAULT_QUIET_START)
    setQuietEnd(quietHours?.end ?? DEFAULT_QUIET_END)
    setQuietTimezone(quietHours?.timezone ?? browserTimeZone)
    setPreferencesHydrated(true)
    hydratedUserId.current = me.user.id
  }, [browserTimeZone, me])

  const timeZoneOptions = useMemo(
    () => getTimeZoneOptions(quietTimezone, browserTimeZone),
    [browserTimeZone, quietTimezone],
  )

  if (!me) {
    return null
  }

  const savePreferences = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preferencesHydrated) {
      return
    }
    // Submitting the form is a user gesture, so this is a safe point to ask for
    // native notification permission when push is on (Safari rejects off-gesture
    // requests). No-op once permission is already granted or denied.
    if (pushEnabled) {
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

  const saveChannelMute = async (
    channelId: string,
    previousMuted: boolean,
    nextMuted: boolean,
  ) => {
    setChannelFeedback(null)
    setChannelMuteOverrides((current) => ({ ...current, [channelId]: nextMuted }))

    try {
      const result = await setChannelMute.mutateAsync({ channelId, muted: nextMuted })
      setChannelMuteOverrides((current) => ({ ...current, [channelId]: result.muted }))
      setChannelFeedback({ kind: 'success', message: 'Channel notification setting saved.' })
    } catch (error) {
      setChannelMuteOverrides((current) => ({ ...current, [channelId]: previousMuted }))
      setChannelFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to save channel setting.',
      })
    }
  }

  return (
    <SettingsPanel
      eyebrow="Account"
      title="Notifications"
      actions={[
        {
          disabled: !preferencesHydrated || updatePreferences.isPending,
          form: 'notification-preferences-form',
          id: 'save-preferences',
          label: updatePreferences.isPending
            ? 'Saving...'
            : preferencesHydrated
              ? 'Save preferences'
              : 'Loading...',
          onSelect: () => undefined,
          primary: true,
          priority: 100,
          submit: true,
        } satisfies PageHeaderAction,
      ]}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <form
          className="grid gap-4"
          id="notification-preferences-form"
          onSubmit={savePreferences}
        >
          <PushPreferenceCard
            disabled={!preferencesHydrated || updatePreferences.isPending}
            pushAssignedWork={pushAssignedWork}
            pushBudgetAlerts={pushBudgetAlerts}
            pushEnabled={pushEnabled}
            pushMentions={pushMentions}
            pushMessages={pushMessages}
            pushPublishedKnowledge={pushPublishedKnowledge}
            setPushAssignedWork={setPushAssignedWork}
            setPushBudgetAlerts={setPushBudgetAlerts}
            setPushEnabled={(next) => {
              setPushEnabled(next)
              if (next) {
                requestNotificationPermission()
              }
            }}
            setPushMentions={setPushMentions}
            setPushMessages={setPushMessages}
            setPushPublishedKnowledge={setPushPublishedKnowledge}
          />

          <section className="admin-card p-4">
            <div className={sectionTitleClass}>Quiet hours</div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="font-semibold text-[color:var(--tx)]">Quiet hours</div>
                <div className="mt-1 text-sm text-[color:var(--tx2)]">
                  {quietHoursEnabled ? 'Enabled' : 'Disabled'}
                </div>
              </div>
              <NotificationToggle
                checked={quietHoursEnabled}
                disabled={!preferencesHydrated || updatePreferences.isPending}
                label="Toggle quiet hours"
                onChange={setQuietHoursEnabled}
              />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
                Start
                <input
                  className="admin-input"
                  disabled={!quietHoursEnabled || !preferencesHydrated || updatePreferences.isPending}
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
                  disabled={!quietHoursEnabled || !preferencesHydrated || updatePreferences.isPending}
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
                  disabled={!quietHoursEnabled || !preferencesHydrated || updatePreferences.isPending}
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

        <section className="admin-card p-4">
          <div className={sectionTitleClass}>Muted channels</div>
          <div className="mt-4 grid gap-2">
            {channels.length === 0 ? (
              <div className="admin-card p-3 text-sm text-[color:var(--tx3)]">
                No channels available.
              </div>
            ) : (
              channels.map((channel) => {
                const muted = channelMuteOverrides[channel.id] ?? channel.muted ?? false
                const pending =
                  setChannelMute.isPending && setChannelMute.variables?.channelId === channel.id

                return (
                  <div
                    key={channel.id}
                    className="admin-card flex items-center justify-between gap-4 p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-[color:var(--tx)]">#{channel.label}</div>
                      <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                        {muted ? 'Muted' : channel.visibility}
                      </div>
                    </div>
                    <NotificationToggle
                      checked={muted}
                      disabled={pending}
                      label={`Toggle ${channel.label} notifications`}
                      onChange={(nextMuted) =>
                        void saveChannelMute(channel.id, muted, nextMuted)}
                    />
                    {pending ? (
                      <span className="sr-only" role="status">
                        Saving channel notification setting
                      </span>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
          <div className="mt-3">
            <FeedbackBanner feedback={channelFeedback} />
          </div>
        </section>
      </div>
    </SettingsPanel>
  )
}
