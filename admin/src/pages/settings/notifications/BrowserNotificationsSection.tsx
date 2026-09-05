import { useEffect, useState } from 'react'
import {
  useSubscribeWebPush,
  useUnsubscribeWebPush,
  useWebPushConfig,
} from '../../../facades/web-push/hooks'
import {
  getExistingSubscription,
  isWebPushSupported,
  subscribeBrowser,
  unsubscribeBrowser,
} from '../../../lib/web-push'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Switch } from '../../../components/primitives/Switch'
import { FeedbackBanner, type SettingsFeedback } from '../FeedbackBanner'

const getNotificationPermission = (): NotificationPermission | null =>
  typeof Notification === 'undefined' ? null : Notification.permission

/**
 * Browser (Web Push) notifications. Independent from the saved push
 * preferences form: this manages the per-browser PushManager subscription and
 * mirrors it to the API. Gracefully degrades when the browser lacks support or
 * when web push is not configured on this instance.
 */
export const BrowserNotificationsSection = () => {
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
      return 'Checking availability…'
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
      <SectionLabel>Browser notifications</SectionLabel>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <div className="font-semibold text-[color:var(--tx)]">Browser notifications</div>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">{describeState()}</div>
        </div>
        <Switch
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
