import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

export interface NativeNotification {
  autoCancel?: boolean
  title: string
  body?: string
  extra?: Record<string, unknown>
  id?: number
}

export type DesktopNotificationEventName =
  | 'approval.created'
  | 'approval.needed'
  | 'approval.resolved'
  | 'mention.created'
  | 'mention.new'
  | 'message.mention'
  | 'message.new'

export interface DesktopNotificationRoute {
  channelId?: string
  eventId?: string
  eventName: DesktopNotificationEventName
  route: string
}

export async function notify(notification: NativeNotification): Promise<boolean> {
  let permissionGranted = await isPermissionGranted()

  if (!permissionGranted) {
    const permission = await requestPermission()
    permissionGranted = permission === 'granted'
  }

  if (!permissionGranted) {
    return false
  }

  sendNotification(notification)
  return true
}
