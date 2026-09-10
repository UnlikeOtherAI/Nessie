import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

type NotificationOptions = Record<string, unknown>
type NotificationRecord = { closed: boolean; options: NotificationOptions; title: string }

type PushEvent = {
  data: { json: () => unknown; text: () => string }
  waitUntil: (promise: Promise<unknown>) => void
}

type PushHandler = (event: PushEvent) => void
type MessageHandler = (event: { data: unknown; waitUntil: (promise: Promise<unknown>) => void }) => void
type NotificationClickHandler = (event: {
  action: string
  notification: { close: () => void; data: unknown }
  waitUntil: (promise: Promise<unknown>) => void
}) => void

type NotificationClickResult = {
  closed: () => boolean
  completion: Promise<unknown>
}

const loadWorker = (cacheEntries = new Map<string, string>(), cacheRead?: Promise<void>): {
  activity: string[]
  clickNotification: (data: unknown, action: string) => NotificationClickResult
  dispatchPush: (payload: unknown) => Promise<void>
  notifications: NotificationRecord[]
  setPushUser: (userId: string | null) => Promise<void>
} => {
  const handlers = new Map<string, PushHandler | MessageHandler | NotificationClickHandler>()
  const activity: string[] = []
  const notifications: NotificationRecord[] = []
  const worker = {
    addEventListener: (
      name: string,
      handler: PushHandler | MessageHandler | NotificationClickHandler,
    ) => handlers.set(name, handler),
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async (url: string) => {
        activity.push(`open:${url}`)
        return {}
      },
    },
    location: { href: 'https://app.nessie.example/sw.js', origin: 'https://app.nessie.example' },
    navigator: {},
    registration: {
      getNotifications: async () => notifications.map((notification) => ({
        ...notification,
        close: () => { notification.closed = true },
        data: notification.options.data,
      })),
      showNotification: async (title: string, options: NotificationOptions) => {
        const notification = { closed: false, options, title }
        notifications.push(notification)
        return notification as never
      },
    },
    skipWaiting: () => undefined,
  }
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, {
    Number,
    Promise,
    Response,
    URL,
    caches: { open: async () => ({
      delete: async (key: string) => cacheEntries.delete(key),
        match: async (key: string) => {
          await cacheRead
          return cacheEntries.has(key) ? new Response(cacheEntries.get(key)) : undefined
        },
      put: async (key: string, value: Response) => { cacheEntries.set(key, await value.text()) },
    }) },
    fetch: async (url: URL) => {
      activity.push(`fetch:${url.href}`)
      return new Response()
    },
    self: worker,
  })

  return {
    activity,
    clickNotification: (data: unknown, action: string) => {
      const waits: Promise<unknown>[] = []
      let closed = false
      ;(handlers.get('notificationclick') as NotificationClickHandler | undefined)?.({
        action,
        notification: { close: () => { closed = true }, data },
        waitUntil: (promise) => waits.push(promise),
      })
      return { closed: () => closed, completion: Promise.all(waits) }
    },
    dispatchPush: async (payload: unknown) => {
      const waits: Promise<unknown>[] = []
      ;(handlers.get('push') as PushHandler | undefined)?.({
        data: { json: () => payload, text: () => '' },
        waitUntil: (promise) => waits.push(promise),
      })
      await Promise.all(waits)
    },
    setPushUser: (userId: string | null) => {
      const waits: Promise<unknown>[] = []
      ;(handlers.get('message') as MessageHandler | undefined)?.({
        data: { type: 'nessie.web-push-user', userId },
        waitUntil: (promise) => waits.push(promise),
      })
      return Promise.all(waits)
    },
    notifications,
  }
}

test('ignores call payloads from an unsupported service-worker protocol version', async () => {
  const worker = loadWorker()
  await worker.setPushUser('user-1')

  await worker.dispatchPush({
    data: { callId: 'call-1', kind: 'call.cancel', recipientUserId: 'user-1', version: '2' },
    title: 'Incoming call',
  })

  assert.deepEqual(worker.notifications, [])
})

test('renders a supported ring with stable interactive call notification options', async () => {
  const worker = loadWorker()
  await worker.setPushUser('user-1')

  await worker.dispatchPush({
    body: 'Ada is calling',
    data: { callId: 'call-1', kind: 'call.ring', recipientUserId: 'user-1', version: '1' },
    title: 'Incoming call',
  })

  const rendered = worker.notifications.map(({ options, title }) => ({ options, title }))
  assert.deepEqual(JSON.parse(JSON.stringify(rendered)), [{
    options: {
      actions: [{ action: 'accept', title: 'Accept' }, { action: 'decline', title: 'Decline' }],
      badge: '/icon-1024.png',
      body: 'Ada is calling',
      data: { callId: 'call-1', kind: 'call.ring', recipientUserId: 'user-1', version: '1' },
      icon: '/icon-1024.png',
      renotify: true,
      requireInteraction: true,
      tag: 'call-call-1',
    },
    title: 'Incoming call',
  }])
})

const callRingData = (recipientUserId: string) => ({
  acceptToken: 'accept-token',
  callId: 'call-1',
  kind: 'call.ring',
  meetingUri: 'https://meet.example/call-1',
  path: '/channels/channel-1',
  recipientUserId,
  version: '1',
})

test('a warm owner accept opens the meeting synchronously before posting the response token', async () => {
  const worker = loadWorker()
  await worker.setPushUser('user-a')

  const click = worker.clickNotification(callRingData('user-a'), 'accept')

  assert.equal(click.closed(), true)
  assert.deepEqual(worker.activity, [
    'open:https://meet.example/call-1',
    'fetch:https://app.nessie.example/api/calls/call-1/respond',
  ])
  await click.completion
  assert.equal(worker.activity.length, 2)
})

test('a cold owner accept opens only the non-mutating authenticated call doorway', async () => {
  const ownerCache = new Map<string, string>([
    ['/.well-known/nessie-web-push-owner', 'user-a'],
  ])
  const worker = loadWorker(ownerCache)

  const click = worker.clickNotification(callRingData('user-a'), 'accept')

  assert.equal(click.closed(), true)
  assert.deepEqual(worker.activity, [
    'open:https://app.nessie.example/channels/channel-1?incomingCall=call-1',
  ])
  await click.completion
  assert.equal(worker.activity.length, 1)
})

test('a stale owner accept closes without opening a window or posting a response token', async () => {
  const worker = loadWorker()
  await worker.setPushUser('user-b')

  const click = worker.clickNotification(callRingData('user-a'), 'accept')

  assert.equal(click.closed(), true)
  assert.deepEqual(worker.activity, [])
  await click.completion
  assert.deepEqual(worker.activity, [])
})

test('does not render a former user payload after logout or another login', async () => {
  const worker = loadWorker()
  await worker.setPushUser('user-a')
  await worker.dispatchPush({ body: 'private A content', data: { recipientUserId: 'user-a' }, title: 'A' })
  await worker.setPushUser(null)
  await worker.dispatchPush({ body: 'former content', data: { recipientUserId: 'user-a' }, title: 'A' })
  await worker.setPushUser('user-b')
  await worker.dispatchPush({ body: 'still A content', data: { recipientUserId: 'user-a' }, title: 'A' })

  assert.equal(worker.notifications.length, 1)
  assert.equal(worker.notifications[0]?.closed, true)
})

test('a restarted worker reads the durable owner and logout blocks offline cleanup failures', async () => {
  const ownerCache = new Map<string, string>()
  const first = loadWorker(ownerCache)
  await first.setPushUser('user-a')
  const restarted = loadWorker(ownerCache)
  await restarted.dispatchPush({ body: 'A content', data: { recipientUserId: 'user-a' }, title: 'A' })
  assert.equal(restarted.notifications.length, 1)

  await restarted.setPushUser(null)
  await restarted.dispatchPush({ body: 'former content', data: { recipientUserId: 'user-a' }, title: 'A' })
  assert.equal(restarted.notifications.length, 1)
})

test('a restarted worker closes a former owner notification when another person signs in', async () => {
  const ownerCache = new Map<string, string>()
  const original = loadWorker(ownerCache)
  await original.setPushUser('user-a')
  await original.dispatchPush({ body: 'A content', data: { recipientUserId: 'user-a' }, title: 'A' })
  const restarted = loadWorker(ownerCache)
  // The browser notification tray is shared even though the worker restarted.
  restarted.notifications.push(...original.notifications)
  await restarted.setPushUser('user-b')
  assert.equal(restarted.notifications[0]?.closed, true)
})

test('serialized owner writes and a fenced cache read cannot restore a former user', async () => {
  const ownerCache = new Map<string, string>()
  const worker = loadWorker(ownerCache)
  const staleWrite = worker.setPushUser('user-a')
  const logout = worker.setPushUser(null)
  await Promise.all([staleWrite, logout])
  const restarted = loadWorker(ownerCache)
  await restarted.dispatchPush({ body: 'A content', data: { recipientUserId: 'user-a' }, title: 'A' })
  assert.equal(restarted.notifications.length, 0)

  let releaseRead: (() => void) | undefined
  const delayedRead = new Promise<void>((resolve) => { releaseRead = resolve })
  ownerCache.set('/.well-known/nessie-web-push-owner', 'user-a')
  const reading = loadWorker(ownerCache, delayedRead)
  const inFlightPush = reading.dispatchPush({ body: 'A content', data: { recipientUserId: 'user-a' }, title: 'A' })
  await reading.setPushUser(null)
  releaseRead?.()
  await inFlightPush
  assert.equal(reading.notifications.length, 0)
})
