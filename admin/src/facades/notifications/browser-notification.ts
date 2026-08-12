import { getNotificationApi } from './permission'

type BrowserNotificationInput = {
  body: string
  channelId: string
  openChannel: (channelId: string, threadId?: string, rootMessageId?: string) => void
  rootMessageId?: string
  threadId?: string
  title: string
}

/** Browser-hosted notification presentation; the toast remains the fallback. */
export const showBrowserNotification = (input: BrowserNotificationInput): void => {
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
