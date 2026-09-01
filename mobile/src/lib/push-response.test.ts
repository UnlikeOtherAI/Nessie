import assert from 'node:assert/strict'
import test from 'node:test'
import type { NotificationResponse } from 'expo-notifications'

import { pathFromNotificationResponse } from './push-response'

const responseFor = (input: { data?: unknown; payload?: unknown }): NotificationResponse => ({
  notification: {
    request: {
      content: { data: input.data ?? null },
      trigger: { payload: input.payload, type: 'push' },
    },
  },
} as NotificationResponse)

const exactPath = '/channels/channel-a/threads/thread-a/replies/root-a'

test('reads the direct APNs body envelope Expo exposes as notification data', () => {
  assert.equal(
    pathFromNotificationResponse(responseFor({
      data: { url: exactPath },
      payload: { body: { url: exactPath } },
    })),
    exactPath,
  )
})

test('uses APNs userInfo.body when an iOS response has no serialized content data', () => {
  assert.equal(
    pathFromNotificationResponse(responseFor({ payload: { body: { url: exactPath } } })),
    exactPath,
  )
})

test('keeps an already-delivered legacy APNs card actionable', () => {
  assert.equal(
    pathFromNotificationResponse(responseFor({ payload: { url: exactPath } })),
    exactPath,
  )
})
