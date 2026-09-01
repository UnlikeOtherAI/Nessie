import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

type NotificationOptions = Record<string, unknown>

type PushEvent = {
  data: { json: () => unknown; text: () => string }
  waitUntil: (promise: Promise<unknown>) => void
}

type PushHandler = (event: PushEvent) => void

const loadWorker = (): {
  dispatchPush: (payload: unknown) => Promise<void>
  notifications: Array<{ options: NotificationOptions; title: string }>
} => {
  const handlers = new Map<string, PushHandler>()
  const notifications: Array<{ options: NotificationOptions; title: string }> = []
  const worker = {
    addEventListener: (name: string, handler: PushHandler) => handlers.set(name, handler),
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => null },
    location: { href: 'https://app.nessie.example/sw.js', origin: 'https://app.nessie.example' },
    navigator: {},
    registration: {
      getNotifications: async () => [],
      showNotification: async (title: string, options: NotificationOptions) => {
        notifications.push({ options, title })
      },
    },
    skipWaiting: () => undefined,
  }
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, {
    Number,
    Promise,
    URL,
    fetch: async () => new Response(),
    self: worker,
  })

  return {
    dispatchPush: async (payload: unknown) => {
      const waits: Promise<unknown>[] = []
      handlers.get('push')?.({
        data: { json: () => payload, text: () => '' },
        waitUntil: (promise) => waits.push(promise),
      })
      await Promise.all(waits)
    },
    notifications,
  }
}

test('ignores call payloads from an unsupported service-worker protocol version', async () => {
  const worker = loadWorker()

  await worker.dispatchPush({
    data: { callId: 'call-1', kind: 'call.cancel', version: '2' },
    title: 'Incoming call',
  })

  assert.deepEqual(worker.notifications, [])
})

test('renders a supported ring with stable interactive call notification options', async () => {
  const worker = loadWorker()

  await worker.dispatchPush({
    body: 'Ada is calling',
    data: { callId: 'call-1', kind: 'call.ring', version: '1' },
    title: 'Incoming call',
  })

  assert.deepEqual(JSON.parse(JSON.stringify(worker.notifications)), [{
    options: {
      actions: [{ action: 'accept', title: 'Accept' }, { action: 'decline', title: 'Decline' }],
      badge: '/icon-1024.png',
      body: 'Ada is calling',
      data: { callId: 'call-1', kind: 'call.ring', version: '1' },
      icon: '/icon-1024.png',
      renotify: true,
      requireInteraction: true,
      tag: 'call-call-1',
    },
    title: 'Incoming call',
  }])
})
