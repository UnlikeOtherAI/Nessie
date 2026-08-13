import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMessageNotificationPath,
  DESKTOP_NOTIFICATION_OPEN_EVENT,
  readDesktopNotificationOpenPath,
  showDesktopNativeNotification,
} from '../src/facades/notifications/desktop-native-notification.js'

const withDesktopWindow = async (run: (notifications: unknown[]) => void | Promise<void>): Promise<void> => {
  const originalWindow = globalThis.window
  const notifications: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI__: {},
      __nessieDesktopNotify: (notification: unknown) => notifications.push(notification),
    },
  })
  try {
    await run(notifications)
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
}

test('uses the exact reply path for a native desktop notification', async () => {
  await withDesktopWindow((notifications) => {
    const path = buildMessageNotificationPath({
      channelId: 'channel-1',
      rootMessageId: 'root-1',
      threadId: 'thread-1',
    })
    assert.equal(showDesktopNativeNotification({ body: 'Reply ready', path, title: 'Nessie' }), true)
    assert.deepEqual(notifications, [{ body: 'Reply ready', path, title: 'Nessie' }])
  })
})

test('only accepts safe Nessie paths from native notification actions', () => {
  assert.equal(
    readDesktopNotificationOpenPath(
      new CustomEvent(DESKTOP_NOTIFICATION_OPEN_EVENT, { detail: { path: '/channels/channel-1' } }),
    ),
    '/channels/channel-1',
  )
  assert.equal(
    readDesktopNotificationOpenPath(
      new CustomEvent(DESKTOP_NOTIFICATION_OPEN_EVENT, { detail: { path: '//outside.example' } }),
    ),
    null,
  )
})
