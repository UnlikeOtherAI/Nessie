/* Nessie admin service worker — web push delivery + notification clicks. */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  if (!event.data) {
    return
  }

  let payload = {}
  try {
    payload = event.data.json()
  } catch (error) {
    payload = { title: 'Nessie', body: event.data.text() }
  }

  const data = payload.data || {}
  // Coalesce at the conversation chosen by the server: the main channel feed
  // stays compact, while independent reply conversations remain visible.
  const tag = data.tag || payload.collapseId || data.rootMessageId || data.channelId || 'nessie'
  const title = payload.subtitle
    ? `${payload.title || 'Nessie'} · ${payload.subtitle}`
    : (payload.title || 'Nessie')
  const count = Number(payload.badge)
  const badgeUpdate = Number.isFinite(count) && count > 0 && typeof self.navigator.setAppBadge === 'function'
    ? self.navigator.setAppBadge(Math.floor(count))
    : Number.isFinite(count) && count === 0 && typeof self.navigator.clearAppBadge === 'function'
      ? self.navigator.clearAppBadge()
      : Promise.resolve()

  event.waitUntil(
    Promise.all([
      badgeUpdate,
      self.registration.showNotification(title, {
        body: payload.body,
        icon: '/icon-1024.png',
        badge: '/icon-1024.png',
        tag,
        data,
      }),
    ]),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Resolve to an absolute URL so it matches an open client's absolute `url`
  // (the worker sends a relative path like "/channels/abc"); otherwise the
  // comparison never matches and a duplicate tab is always opened.
  const relative = (event.notification.data && event.notification.data.url) || '/'
  const targetUrl = new URL(relative, self.location.origin).href

  event.waitUntil(
    self.clients
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
      }),
  )
})
