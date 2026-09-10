/* Nessie admin service worker — web push delivery + notification clicks. */

const CALL_PUSH_PROTOCOL_VERSION = '1'
let activePushUserId
let pushOwnerGeneration = 0
let pushOwnerWrite = Promise.resolve()
const PUSH_OWNER_CACHE = 'nessie-web-push-owner-v1'
const PUSH_OWNER_KEY = '/.well-known/nessie-web-push-owner'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// The browser endpoint survives a login. Only the person the SPA most recently
// authenticated may render a payload addressed to them; an absent owner fails
// closed while the page reconnects after a worker restart.
self.addEventListener('message', (event) => {
  const message = event.data
  if (!isObject(message) || message.type !== 'nessie.web-push-user') return
  const userId = typeof message.userId === 'string' && message.userId.length > 0
    ? message.userId
    : null
  activePushUserId = userId
  const generation = ++pushOwnerGeneration
  event.waitUntil?.(Promise.all([
    storePushOwner(userId, generation),
    closeNotificationsForOtherOwners(userId),
  ]))
})

const closeNotificationsForOtherOwners = async (userId) => {
  const notifications = await self.registration.getNotifications()
  // An older owner-change cleanup can resume after a new login. Re-read the
  // synchronous owner it must protect before closing anything from that tray.
  const currentUserId = activePushUserId === undefined ? userId : activePushUserId
  notifications.forEach((notification) => {
    const recipientUserId = isObject(notification.data) ? notification.data.recipientUserId : null
    if (!currentUserId || recipientUserId !== currentUserId) notification.close()
  })
}

const storePushOwner = (userId, generation) => {
  pushOwnerWrite = pushOwnerWrite.catch(() => undefined).then(async () => {
    if (generation !== pushOwnerGeneration) return
    const cache = await caches.open(PUSH_OWNER_CACHE)
    if (generation !== pushOwnerGeneration) return
    if (userId) await cache.put(PUSH_OWNER_KEY, new Response(userId))
    else await cache.delete(PUSH_OWNER_KEY)
  })
  return pushOwnerWrite
}

const currentPushOwner = async () => {
  if (activePushUserId !== undefined) return activePushUserId
  const generation = pushOwnerGeneration
  try {
    const cached = await (await caches.open(PUSH_OWNER_CACHE)).match(PUSH_OWNER_KEY)
    const cachedUserId = cached ? await cached.text() : null
    if (generation !== pushOwnerGeneration) return activePushUserId
    activePushUserId = cachedUserId
  } catch {
    if (generation !== pushOwnerGeneration) return activePushUserId
    activePushUserId = null
  }
  return activePushUserId
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const isCallPush = (data) => typeof data.kind === 'string' && data.kind.startsWith('call.')

const isSupportedCallPush = (data) =>
  data.version === CALL_PUSH_PROTOCOL_VERSION
  && (data.kind === 'call.ring' || data.kind === 'call.cancel')

const callTag = (data) => `call-${data.callId}`

const notificationOptions = (payload, data, tag) => ({
  body: payload.body,
  icon: '/icon-1024.png',
  badge: '/icon-1024.png',
  tag,
  data,
})

const badgeUpdateFor = (payload) => {
  const count = Number(payload.badge)
  if (Number.isFinite(count) && count > 0 && typeof self.navigator.setAppBadge === 'function') {
    return self.navigator.setAppBadge(Math.floor(count))
  }
  if (Number.isFinite(count) && count === 0 && typeof self.navigator.clearAppBadge === 'function') {
    return self.navigator.clearAppBadge()
  }
  return Promise.resolve()
}

const titleFor = (payload) =>
  payload.subtitle
    ? `${payload.title || 'Nessie'} · ${payload.subtitle}`
    : (payload.title || 'Nessie')

const closeNotificationsWithTag = async (tag) => {
  const notifications = await self.registration.getNotifications({ tag })
  notifications.forEach((notification) => notification.close())
}

const closeCallRing = async (data) => {
  const tag = callTag(data)
  await closeNotificationsWithTag(tag)

  // Chromium expects each push to show a notification. This low-volume cancel
  // cleanup is allowed to use a silent notification that closes immediately;
  // a habitual no-show push pattern would be penalised by the platform.
  await self.registration.showNotification('Nessie', {
    icon: '/icon-1024.png',
    badge: '/icon-1024.png',
    data,
    silent: true,
    tag,
  })
  await closeNotificationsWithTag(tag)
}

const callChannelUrl = (data, queryKey) => {
  if (typeof data.callId !== 'string' || data.callId.length === 0) return '/'
  const candidate = typeof data.path === 'string' ? data.path : data.url
  if (typeof candidate !== 'string') return '/'

  let url
  try {
    url = new URL(candidate, self.location.origin)
  } catch {
    return '/'
  }
  if (url.origin !== self.location.origin || !/^\/channels\/[^/]+$/.test(url.pathname)) return '/'

  url.search = ''
  url.searchParams.set(queryKey, data.callId)
  return `${url.pathname}${url.search}`
}

const focusOrOpen = (relative) => {
  const targetUrl = new URL(relative, self.location.origin).href
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientList) => {
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
      return undefined
    })
}

const apiOrigin = () => {
  const configured = new URL(self.location.href).searchParams.get('apiBase')
  if (!configured) return self.location.origin
  try {
    return new URL(configured).origin
  } catch {
    return self.location.origin
  }
}

const postCallResponse = (data, action) => {
  const token = action === 'accept' ? data.acceptToken : data.declineToken
  if (typeof data.callId !== 'string' || typeof token !== 'string') return Promise.resolve()
  const responseUrl = new URL(`/api/calls/${encodeURIComponent(data.callId)}/respond`, apiOrigin())
  return fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => undefined)
}

const openMeetingOrFallback = async (openedMeeting, fallbackUrl) => {
  const client = await Promise.resolve(openedMeeting).catch(() => null)
  if (client || !self.clients.openWindow) return
  await self.clients.openWindow(new URL(fallbackUrl, self.location.origin).href).catch(() => undefined)
}

self.addEventListener('push', (event) => {
  if (!event.data) {
    return
  }

  let payload = {}
  try {
    const parsed = event.data.json()
    payload = isObject(parsed) ? parsed : {}
  } catch (error) {
    payload = { title: 'Nessie', body: event.data.text() }
  }

  event.waitUntil((async () => {
    const data = isObject(payload.data) ? payload.data : {}
    const recipientUserId = data.recipientUserId
    if (typeof recipientUserId !== 'string' || recipientUserId !== await currentPushOwner()) {
      return
    }
    if (isCallPush(data)) {
    // A stale worker must never mistake a future cancel payload for a visible
    // generic notification, so unsupported call protocol versions are ignored.
    if (!isSupportedCallPush(data)) return
    if (data.kind === 'call.cancel') {
      await Promise.all([badgeUpdateFor(payload), closeCallRing(data)])
      return
    }

    await Promise.all([
        badgeUpdateFor(payload),
        self.registration.showNotification(titleFor(payload), {
          ...notificationOptions(payload, data, callTag(data)),
          actions: [
            { action: 'accept', title: 'Accept' },
            { action: 'decline', title: 'Decline' },
          ],
          requireInteraction: true,
          renotify: true,
        }),
      ])
    if (recipientUserId !== await currentPushOwner()) await closeNotificationsWithTag(callTag(data))
    return
    }

  // Coalesce at the conversation chosen by the server: the main channel feed
  // stays compact, while independent reply conversations remain visible.
  const tag = data.tag || payload.collapseId || data.rootMessageId || data.channelId || 'nessie'
    await Promise.all([
      badgeUpdateFor(payload),
      self.registration.showNotification(titleFor(payload), notificationOptions(payload, data, tag)),
    ])
    if (recipientUserId !== await currentPushOwner()) await closeNotificationsWithTag(tag)
  })())
})

self.addEventListener('notificationclick', (event) => {
  const data = isObject(event.notification.data) ? event.notification.data : {}
  event.waitUntil((async () => {
    if (typeof data.recipientUserId !== 'string' || data.recipientUserId !== await currentPushOwner()) {
      event.notification.close()
      return
    }
  if (isCallPush(data)) {
    if (!isSupportedCallPush(data)) {
      event.notification.close()
      return
    }
    if (event.action === 'accept') {
      // This is deliberately the first operation: notification-click user
      // activation can be lost by awaiting even one promise before openWindow.
      const openedMeeting = self.clients.openWindow(data.meetingUri)
      event.notification.close()
      await Promise.all([
        openMeetingOrFallback(openedMeeting, callChannelUrl(data, 'acceptCall')),
        postCallResponse(data, 'accept'),
      ])
      return
    }
    if (event.action === 'decline') {
      event.notification.close()
      await postCallResponse(data, 'decline')
      return
    }

    // A notification body click only opens the incoming-call dialog. It must
    // not become an implicit accept merely because action buttons are absent.
    event.notification.close()
    await focusOrOpen(callChannelUrl(data, 'incomingCall'))
    return
  }

  event.notification.close()
  await focusOrOpen(data.url || '/')
  })())
})

self.addEventListener('notificationclose', () => {
  // Dismissing a ring stops this device's banner only; it never declines the
  // user-level invite or sends a response token to the API.
})
