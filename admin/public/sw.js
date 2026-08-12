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

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Nessie', {
      // The Web Notifications API has no subtitle, so preserve the destination
      // as the first line of the body.
      body: payload.subtitle ? `${payload.subtitle}\n${payload.body}` : payload.body,
      icon: '/icon-1024.png',
      badge: '/icon-1024.png',
      tag,
      data,
    }),
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
