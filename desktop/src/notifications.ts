import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

export interface NativeNotification {
  title: string
  body?: string
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

// TODO(desktop): subscribe to admin SSE 'message.new' and call notify().
