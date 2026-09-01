import { getNotificationApi } from './permission'
import {
  buildMessageNotificationPath,
  showDesktopNativeNotification,
} from './desktop-native-notification'

type BrowserNotificationInput = {
  body: string
  channelId: string
  openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
  rootMessageId?: string
  threadId?: string
  title: string
}

/**
 * Sends a system notification through Tauri on desktop and the Web Notification
 * API elsewhere. The in-app toast remains the foreground fallback.
 */
export const showBrowserNotification = (input: BrowserNotificationInput): void => {
  if (showDesktopNativeNotification({
    body: input.body,
    path: buildMessageNotificationPath(input),
    title: input.title,
  })) {
    return
  }

  const notificationApi = getNotificationApi()
  if (!notificationApi || notificationApi.permission !== 'granted') return

  try {
    const notification = new notificationApi(input.title, {
      body: input.body,
      tag: input.rootMessageId ?? input.threadId ?? input.channelId,
    })
    notification.addEventListener('click', () => {
      input.openChannel(input.channelId, input.threadId, input.rootMessageId)
      notification.close()
    })
  } catch {
    // Native notification support varies by host webview; the in-app toast remains.
  }
}
