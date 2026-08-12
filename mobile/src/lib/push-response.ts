import type {
  NotificationRequest,
  NotificationResponse,
  PushNotificationTrigger,
} from 'expo-notifications'
import { pathFromPushData, type PushData } from './push-navigation'

const isPushData = (data: unknown): data is PushData =>
  typeof data === 'object' && data !== null && !Array.isArray(data)

const isRemotePushTrigger = (
  trigger: NotificationRequest['trigger'],
): trigger is PushNotificationTrigger =>
  trigger !== null && typeof trigger === 'object' && 'type' in trigger && trigger.type === 'push'

/**
 * Resolves the exact internal destination from every native transport shape.
 * Direct APNs and FCM delivery encode data in `body` so Expo exposes it through
 * `content.data`; the raw payload fallback keeps already-delivered legacy APNs
 * cards actionable after the sender contract was corrected.
 */
export const pathFromNotificationResponse = (
  response: NotificationResponse,
): string | null => {
  const request = response.notification.request
  const candidates: unknown[] = [request.content.data]
  if (isRemotePushTrigger(request.trigger)) {
    const payload = request.trigger.payload
    if (isPushData(payload)) {
      candidates.push(payload.body, payload)
    }
  }

  for (const data of candidates) {
    if (!isPushData(data)) continue
    const path = pathFromPushData(data)
    if (path) return path
  }
  return null
}
