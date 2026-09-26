import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useSubscribeWebPush,
  useUnsubscribeWebPush,
  useWebPushConfig,
} from '../../../facades/web-push/hooks'
import {
  getExistingSubscription,
  isWebPushSupported,
  subscribeBrowser,
} from '../../../lib/web-push'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Switch } from '../../../components/primitives/Switch'
import { FeedbackBanner, type SettingsFeedback } from '../FeedbackBanner'

const getNotificationPermission = (): NotificationPermission | null =>
  typeof Notification === 'undefined' ? null : Notification.permission

/**
 * Browser (Web Push) notifications. Independent from the saved push
 * preferences form: this registers the browser's PushManager subscription with
 * the current tenant. Browser subscriptions outlive login, so the visible
 * state comes from this tenant's server enrollment rather than PushManager
 * alone. Gracefully degrades when web push is unavailable.
 */
export const BrowserNotificationsSection = () => {
  const { t } = useTranslation('settings')
  const { data: config, isLoading: configLoading } = useWebPushConfig()
  const subscribeWebPush = useSubscribeWebPush()
  const unsubscribeWebPush = useUnsubscribeWebPush()

  const [supported] = useState(() => isWebPushSupported())
  const [browserEndpoint, setBrowserEndpoint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  useEffect(() => {
    if (!supported) {
      return
    }
    let cancelled = false
    void getExistingSubscription().then((subscription) => {
      if (!cancelled) {
        setBrowserEndpoint(subscription?.endpoint ?? null)
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
  const subscribed = Boolean(
    browserEndpoint && config?.registeredEndpoints.includes(browserEndpoint),
  )

  const describeState = (): string => {
    if (!supported) {
      return t('notifications.browserUnsupported')
    }
    if (configLoading) {
      return t('notifications.checkingAvailability')
    }
    if (!configEnabled) {
      return t('notifications.browserNotConfigured')
    }
    if (denied) {
      return t('notifications.browserBlocked')
    }
    return subscribed
      ? t('notifications.browserEnabled')
      : t('notifications.browserDisabled')
  }

  const handleToggle = async (next: boolean) => {
    setFeedback(null)
    setBusy(true)
    try {
      if (next) {
        if (!publicKey) {
          throw new Error(t('notifications.browserNotConfigured'))
        }
        const subscription = await subscribeBrowser(publicKey)
        const registration = await subscribeWebPush.mutateAsync(subscription)
        setBrowserEndpoint(registration.endpoint)
        setFeedback({ kind: 'success', message: t('notifications.browserEnabledToast') })
      } else {
        if (browserEndpoint) {
          await unsubscribeWebPush.mutateAsync({ endpoint: browserEndpoint })
        }
        setFeedback({ kind: 'success', message: t('notifications.browserDisabledToast') })
      }
    } catch (error) {
      setFeedback({
        kind: 'error',
        message:
          error instanceof Error ? error.message : t('notifications.browserUpdateFailed'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>{t('notifications.browserNotifications')}</SectionLabel>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <div className="font-semibold text-[color:var(--tx)]">{t('notifications.browserNotifications')}</div>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">{describeState()}</div>
        </div>
        <Switch
          checked={subscribed}
          disabled={toggleDisabled}
          label={t('notifications.toggleBrowser')}
          onChange={(next) => void handleToggle(next)}
        />
      </div>
      <div className="mt-3">
        <FeedbackBanner feedback={feedback} />
      </div>
    </section>
  )
}
