import { buildChannelMessagePath } from '@nessie/schemas'
import { isDesktopApp } from '../../lib/desktop'

export const DESKTOP_NOTIFICATION_OPEN_EVENT = 'nessie:desktop-notification-open'

type DesktopNativeNotificationInput = {
  body: string
  path: string
  title: string
}

type DesktopNotificationWindow = Window & {
  __nessieDesktopNotify?: (input: DesktopNativeNotificationInput) => Promise<boolean> | boolean
  __nessieDesktopRequestNotificationPermission?: () => Promise<boolean> | boolean
}

const isInternalPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')

export const buildMessageNotificationPath = (input: {
  channelId: string
  rootMessageId?: string
  threadId?: string
}): string =>
  input.threadId && input.rootMessageId
    ? buildChannelMessagePath({
        channelId: input.channelId,
        messageId: input.rootMessageId,
        rootMessageId: input.rootMessageId,
        threadId: input.threadId,
      })
    : `/channels/${input.channelId}`

export const showDesktopNativeNotification = (input: DesktopNativeNotificationInput): boolean => {
  if (!isDesktopApp()) return false
  const notify = (window as DesktopNotificationWindow).__nessieDesktopNotify
  if (typeof notify !== 'function') return false
  void Promise.resolve(notify(input)).catch(() => undefined)
  return true
}

/** Requests macOS notification permission from the user’s Settings interaction. */
export const requestDesktopNotificationPermission = (): boolean => {
  if (!isDesktopApp()) return false
  const request = (window as DesktopNotificationWindow).__nessieDesktopRequestNotificationPermission
  if (typeof request !== 'function') return false
  void Promise.resolve(request()).catch(() => undefined)
  return true
}

export const readDesktopNotificationOpenPath = (event: Event): string | null => {
  const detail = (event as CustomEvent<unknown>).detail
  if (typeof detail !== 'object' || detail === null || !('path' in detail)) return null
  const path = detail.path
  return isInternalPath(path) ? path : null
}
